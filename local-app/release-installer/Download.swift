import CoreServices
import CryptoKit
import Darwin
import Foundation

struct InstallerManifest: Codable, Sendable {
    struct Part: Codable, Sendable {
        let url: String
        let size: Int64
        let sha256: String
    }

    let filename: String
    let sha256: String
    let size: Int64
    let parts: [Part]
}

private enum DownloadError: LocalizedError {
    case manifest
    case response(Int)
    case integrity
    case quarantine

    var errorDescription: String? {
        switch self {
        case .manifest: "The installer’s release information is invalid. Download a fresh installer from GitHub."
        case let .response(status): "GitHub could not deliver the installer (HTTP \(status)). Try again later."
        case .integrity: "The download did not match the published installer. Check your connection and retry."
        case .quarantine: "macOS couldn’t mark the disk image as a web download. Try saving it on your Mac."
        }
    }
}

private final class PartProgress: NSObject, URLSessionDownloadDelegate {
    let expectedSize: Int64
    let update: @Sendable (Int64) -> Void

    init(size: Int64, update: @escaping @Sendable (Int64) -> Void) {
        expectedSize = size
        self.update = update
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard totalBytesWritten <= expectedSize else {
            downloadTask.cancel()
            return
        }
        update(totalBytesWritten)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {}

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(request.url?.scheme == "https" ? request : nil)
    }
}

enum InstallerDownload {
    static func run(manifest: InstallerManifest, destination: URL,
                    configuration: URLSessionConfiguration = .ephemeral,
                    progress: @escaping @Sendable (Double) -> Void) async throws {
        let urls = try validate(manifest)
        try Task.checkCancellation()

        // The caller owns the private staging directory. Publish the final name only after verification.
        let manager = FileManager.default
        var partial = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        let descriptor = open(partial.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { try? manager.removeItem(at: partial) }
        let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? output.close() }

        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 12 * 60 * 60
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }

        var wholeHash = SHA256()
        var written: Int64 = 0
        progress(0)
        for (part, url) in zip(manifest.parts, urls) {
            try Task.checkCancellation()
            let finished = Double(written)
            let delegate = PartProgress(size: part.size) { bytes in
                progress((finished + 0.95 * Double(bytes)) / Double(manifest.size))
            }
            let downloaded = try await download(url, with: session, delegate: delegate)
            defer { try? manager.removeItem(at: downloaded) }
            let input = try FileHandle(forReadingFrom: downloaded)
            defer { try? input.close() }
            var partHash = SHA256()
            var copied: Int64 = 0
            while true {
                try Task.checkCancellation()
                let count = try autoreleasepool {
                    guard let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty else { return 0 }
                    guard Int64(data.count) <= part.size - copied else { throw DownloadError.integrity }
                    try output.write(contentsOf: data)
                    partHash.update(data: data)
                    wholeHash.update(data: data)
                    return data.count
                }
                if count == 0 { break }
                copied += Int64(count)
            }
            guard copied == part.size, hex(partHash.finalize()) == part.sha256.lowercased() else {
                throw DownloadError.integrity
            }
            written += copied
            if written < manifest.size { progress(Double(written) / Double(manifest.size)) }
        }
        guard written == manifest.size, hex(wholeHash.finalize()) == manifest.sha256.lowercased() else {
            throw DownloadError.integrity
        }
        try output.close()
        try Task.checkCancellation()

        var properties = URLResourceValues()
        let origin = urls[0].deletingLastPathComponent().lastPathComponent
        let releasePage = URL(string: "https://github.com/noestradamus/Cliptext/releases/tag/")!
            .appendingPathComponent(origin)
        properties.quarantineProperties = [
            kLSQuarantineTypeKey as String: kLSQuarantineTypeWebDownload,
            kLSQuarantineOriginURLKey as String: releasePage
        ]
        try partial.setResourceValues(properties)
        partial.removeAllCachedResourceValues()
        guard try partial.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties != nil else {
            throw DownloadError.quarantine
        }
        try manager.moveItem(at: partial, to: destination)
        progress(1)
    }

    private static func download(_ url: URL, with session: URLSession, delegate: PartProgress) async throws -> URL {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        for attempt in 0..<3 {
            do {
                let (file, response) = try await session.download(for: request, delegate: delegate)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200 else {
                    try? FileManager.default.removeItem(at: file)
                    throw DownloadError.response(status)
                }
                return file
            } catch {
                try Task.checkCancellation()
                let retryable: Bool
                switch error {
                case let DownloadError.response(status):
                    retryable = status == 408 || status == 429 || (500...599).contains(status)
                case let network as URLError:
                    retryable = [.timedOut, .networkConnectionLost, .cannotFindHost,
                                 .dnsLookupFailed, .cannotConnectToHost].contains(network.code)
                default:
                    retryable = false
                }
                guard retryable, attempt < 2 else { throw error }
                try await Task.sleep(for: .seconds(2 << attempt))
            }
        }
        throw DownloadError.integrity
    }

    private static func validate(_ manifest: InstallerManifest) throws -> [URL] {
        func isDigest(_ value: String) -> Bool {
            value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }
        }
        func isName(_ value: String) -> Bool {
            value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*$"#, options: .regularExpression) != nil
        }
        guard isName(manifest.filename), manifest.filename.hasSuffix(".dmg"), manifest.size > 0,
              isDigest(manifest.sha256), !manifest.parts.isEmpty else { throw DownloadError.manifest }
        var sum: Int64 = 0
        var urls = [URL]()
        for part in manifest.parts {
            guard part.size > 0, part.size <= manifest.size - sum, isDigest(part.sha256),
                  let url = URL(string: part.url), url.scheme == "https", url.host == "github.com",
                  url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil else {
                throw DownloadError.manifest
            }
            let path = url.pathComponents
            guard path.count == 7, Array(path.prefix(5)) == ["/", "noestradamus", "Cliptext", "releases", "download"],
                  isName(path[5]), isName(path[6]), urls.first.map({ $0.pathComponents[5] == path[5] }) ?? true,
                  !urls.contains(url) else { throw DownloadError.manifest }
            sum += part.size
            urls.append(url)
        }
        guard sum == manifest.size else { throw DownloadError.manifest }
        return urls
    }

    private static func hex(_ digest: SHA256.Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}

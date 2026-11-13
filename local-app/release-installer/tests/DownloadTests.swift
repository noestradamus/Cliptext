import CryptoKit
import Foundation

private final class FixtureServer: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let body = Data((url.lastPathComponent == "first" ? "Clip" : "text").utf8)
        // The first asset has no Content-Length; the manifest owns the expected size.
        let headers = url.lastPathComponent == "first" ? [:] : ["Content-Length": String(body.count)]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client!.urlProtocol(self, didLoad: body)
        client!.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@main struct DownloadTests {
    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func main() async throws {
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try files.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? files.removeItem(at: directory) }
        let output = directory.appendingPathComponent("Fixture.dmg")
        let base = "https://github.com/noestradamus/Cliptext/releases/download/fixture/"
        let first = InstallerManifest.Part(url: base + "first", size: 4, sha256: digest("Clip"))
        let second = InstallerManifest.Part(url: base + "second", size: 4, sha256: digest("text"))

        func download(_ parts: [InstallerManifest.Part], _ checksum: String) async throws {
            let session = URLSessionConfiguration.ephemeral
            session.protocolClasses = [FixtureServer.self]
            let manifest = InstallerManifest(filename: "Fixture.dmg", sha256: checksum,
                                             size: parts.reduce(0) { $0 + $1.size }, parts: parts)
            try await InstallerDownload.run(manifest: manifest, destination: output, configuration: session) { fraction in
                precondition((0...1).contains(fraction), "Download progress out of range")
            }
        }

        try await download([first, second], digest("Cliptext"))
        let contents = try String(contentsOf: output, encoding: .utf8)
        precondition(contents == "Cliptext", "Unexpected assembled bytes")
        let quarantine = try output.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties
        precondition(quarantine != nil, "Missing macOS download quarantine")
        try files.removeItem(at: output)

        let badLength = InstallerManifest.Part(url: second.url, size: 5, sha256: second.sha256)
        let badDigest = InstallerManifest.Part(url: second.url, size: 4, sha256: digest("oops"))
        for (lastPart, checksum) in [(badLength, digest("Cliptext")), (badDigest, digest("Cliptext")), (second, digest("oops"))] {
            do {
                try await download([first, lastPart], checksum)
                fatalError("An invalid installer was accepted")
            } catch {
                let leftovers = try files.contentsOfDirectory(atPath: directory.path)
                precondition(leftovers.isEmpty, "Failed download left files in staging")
            }
        }
        print("Passed download, assembly, quarantine, integrity and cleanup tests.")
    }
}

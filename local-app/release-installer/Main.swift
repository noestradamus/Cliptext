import AppKit
import Darwin
import SwiftUI

@MainActor
private final class Installer: ObservableObject {
    enum Phase {
        case ready, downloading, cancelling, finished(URL, opened: Bool), failed(String), unavailable(String)
    }

    @Published private(set) var phase = Phase.ready
    @Published private(set) var progress = 0.0
    private(set) var task: Task<Void, Never>?
    private let manifest: InstallerManifest?

    init() {
        guard let resource = Bundle.main.url(forResource: "manifest", withExtension: "json"),
              let data = try? Data(contentsOf: resource),
              let release = try? JSONDecoder().decode(InstallerManifest.self, from: data),
              !release.filename.isEmpty, !release.filename.hasPrefix("."),
              (release.filename as NSString).lastPathComponent == release.filename,
              (release.filename as NSString).pathExtension == "dmg", release.size > 0 else {
            manifest = nil
            phase = .unavailable("This installer is missing its release details. Download a fresh copy from the Cliptext release page.")
            return
        }
        manifest = release
    }

    var size: String {
        ByteCountFormatter.string(fromByteCount: manifest?.size ?? 0, countStyle: .file)
    }

    func download() {
        guard task == nil, let manifest else { return }
        phase = .downloading
        progress = 0
        task = Task { [self] in
            defer { task = nil }
            do {
                let files = FileManager.default
                let downloads = try files.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                // The replacement directory is private, temporary and on the destination volume.
                let working = try files.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: downloads, create: true)
                defer { try? files.removeItem(at: working) }
                let staging = working.appendingPathComponent("payload", isDirectory: true)
                try files.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                let partial = staging.appendingPathComponent(manifest.filename)
                try await InstallerDownload.run(manifest: manifest, destination: partial) { [weak self] fraction in
                    Task { @MainActor in
                        guard let self, case .downloading = self.phase else { return }
                        self.progress = max(self.progress, min(1, fraction))
                    }
                }
                try Task.checkCancellation()
                let image = try Self.save(verified: partial, in: downloads)
                open(image)
            } catch {
                phase = Task.isCancelled ? .ready : .failed(error.localizedDescription)
            }
        }
    }

    // A concurrent download or an existing disk image always keeps its original name and contents.
    private static func save(verified source: URL, in directory: URL) throws -> URL {
        let stem = source.deletingPathExtension().lastPathComponent
        for index in 1...1000 {
            let name = index == 1 ? source.lastPathComponent : "\(stem) (\(index)).dmg"
            let target = directory.appendingPathComponent(name)
            if renamex_np(source.path, target.path, UInt32(RENAME_EXCL)) == 0 { return target }
            let code = errno
            if code != EEXIST { throw NSError(domain: NSPOSIXErrorDomain, code: Int(code)) }
        }
        throw CocoaError(.fileWriteFileExists)
    }

    func cancel() {
        phase = .cancelling
        task?.cancel()
    }

    func open(_ image: URL) {
        phase = .finished(image, opened: NSWorkspace.shared.open(image))
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    let installer = Installer()

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let running = installer.task else { return .terminateNow }
        installer.cancel()
        Task {
            await running.value
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

private struct InstallerView: View {
    @ObservedObject var installer: Installer

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Install Cliptext", systemImage: "arrow.down.app").font(.title.bold())
            switch installer.phase {
            case .ready:
                Text("Download the \(installer.size) disk image to Downloads. It includes Cliptext and its local models.")
                Button("Download Cliptext") { installer.download() }.keyboardShortcut(.defaultAction)
            case .downloading, .cancelling:
                ProgressView(value: installer.progress).accessibilityLabel("Download progress")
                HStack {
                    if case .cancelling = installer.phase {
                        Text("Cancelling…")
                    } else {
                        Text("Downloading and verifying · \(Int(installer.progress * 100))%")
                        Spacer()
                        Button("Cancel") { installer.cancel() }
                    }
                }
            case let .finished(image, opened):
                Text(opened ? "Drag Cliptext to Applications in the disk image window." : "Your verified disk image is saved in Downloads. Double-click it in Finder to install Cliptext.")
                HStack {
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([image]) }
                    Button("Open Disk Image") { installer.open(image) }.keyboardShortcut(.defaultAction)
                }
            case let .failed(detail):
                Text(detail).textSelection(.enabled)
                Button("Try Again") { installer.download() }.keyboardShortcut(.defaultAction)
            case let .unavailable(detail):
                Text(detail)
            }
        }
        .frame(width: 400, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(24)
    }
}

@main
private struct CliptextInstallerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("Cliptext Installer", id: "installer") {
            InstallerView(installer: delegate.installer)
        }
        .windowResizability(.contentSize)
    }
}

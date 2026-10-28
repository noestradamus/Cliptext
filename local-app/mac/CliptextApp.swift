import AppKit
import Foundation
import WebKit
import UniformTypeIdentifiers
import Darwin

private struct DownloadDestination {
    let temporary: URL
    let final: URL
}

@MainActor
final class CliptextAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var mainWindow: NSWindow!
    private var webView: WKWebView!
    private var children: [NSWindow] = []
    private var server: Process?
    private var serverLog: FileHandle?
    private var readyTimer: Timer?
    private var quitTimer: Timer?
    private var readyURL: URL!
    private var dataURL: URL!
    private var origin: URL?
    private var requestedPort = 47321
    private var launchTime = Date()
    private var quitting = false
    private var terminationPending = false
    private var checkingDraft = false
    private var repliedToQuit = false
    private var startupFailurePresented = false
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var destinations: [ObjectIdentifier: DownloadDestination] = [:]
    private var downloadWindows: [ObjectIdentifier: NSWindow] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenus()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = makeWebView(configuration)
        mainWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        mainWindow.title = "Cliptext"
        mainWindow.minSize = NSSize(width: 760, height: 560)
        mainWindow.isReleasedWhenClosed = false
        mainWindow.delegate = self
        mainWindow.center()
        mainWindow.contentView = loadingView()
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        do { try startServer() }
        catch { showStartupFailure(error.localizedDescription) }
    }

    private func argument(_ name: String) -> String? {
        guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[index + 1]
    }

    private func startServer() throws {
        guard let resources = Bundle.main.resourceURL else { throw appError("The app resources are missing.") }
        let environment = ProcessInfo.processInfo.environment
        let selectedData = argument("--data-dir") ?? environment["CLIPTEXT_DATA_DIR"]
        let defaultData = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Cliptext", isDirectory: true)
        dataURL = selectedData.map { URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath, isDirectory: true) } ?? defaultData
        guard let port = Int(argument("--port") ?? environment["CLIPTEXT_PORT"] ?? "47321"), (0...65535).contains(port) else {
            throw appError("Choose a local port between 0 and 65535.")
        }
        requestedPort = port
        try FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let logs = dataURL.appendingPathComponent("logs", isDirectory: true)
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        readyURL = dataURL.appendingPathComponent("ready-\(ProcessInfo.processInfo.processIdentifier).json")
        try? FileManager.default.removeItem(at: readyURL)
        let logURL = logs.appendingPathComponent("mac-app.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        serverLog = try FileHandle(forWritingTo: logURL)
        try serverLog?.seekToEnd()
        let process = Process()
        process.executableURL = resources.appendingPathComponent("engine/bin/node")
        process.arguments = [resources.appendingPathComponent("server/main.mjs").path,
            "--data-dir", dataURL.path,
            "--engine-bundle", resources.appendingPathComponent("engine").path,
            "--models-dir", resources.appendingPathComponent("models").path,
            "--client-dir", resources.appendingPathComponent("client").path,
            "--migrations-dir", resources.appendingPathComponent("migrations").path,
            "--ready-file", readyURL.path, "--port", String(port),
            "--supervisor-pid", String(ProcessInfo.processInfo.processIdentifier)]
        process.currentDirectoryURL = dataURL
        process.environment = ["PATH": resources.appendingPathComponent("engine/bin").path + ":/usr/bin:/bin:/usr/sbin:/sbin",
                               "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"]
        process.standardOutput = serverLog
        process.standardError = serverLog
        process.standardInput = FileHandle.nullDevice
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async { self?.serverEnded(ended) }
        }
        server = process
        try process.run()
        launchTime = Date()
        readyTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.checkReady() }
        }
    }

    private func checkReady() {
        guard let server, server.isRunning else { return }
        if let data = try? Data(contentsOf: readyURL),
           let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let pid = value["pid"] as? Int, pid == Int(server.processIdentifier),
           let address = value["url"] as? String, let url = URL(string: address),
           url.scheme == "http", url.host == "127.0.0.1", url.user == nil, url.password == nil,
           url.query == nil, validLaunchFragment(url.fragment), url.path.isEmpty || url.path == "/",
           let port = url.port, (1...65535).contains(port), requestedPort == 0 || requestedPort == port {
            readyTimer?.invalidate(); readyTimer = nil
            var plain = URLComponents(url: url, resolvingAgainstBaseURL: false)
            plain?.fragment = nil
            origin = plain?.url
            mainWindow.contentView = webView
            webView.load(URLRequest(url: url))
            mainWindow.makeFirstResponder(webView)
        } else if Date().timeIntervalSince(launchTime) > 45 {
            readyTimer?.invalidate(); readyTimer = nil
            showStartupFailure("The local service did not become available. Its log is in \(dataURL.appendingPathComponent("logs/mac-app.log").path).")
        }
    }

    private func serverEnded(_ process: Process) {
        readyTimer?.invalidate(); readyTimer = nil
        try? serverLog?.close(); serverLog = nil
        if quitting {
            quitTimer?.invalidate(); quitTimer = nil
            if !repliedToQuit { repliedToQuit = true; NSApp.reply(toApplicationShouldTerminate: true) }
        } else {
            showStartupFailure("The local service stopped. Your library remains saved on this Mac.")
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow.makeKeyAndOrderFront(nil)
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting || terminationPending { return .terminateLater }
        terminationPending = true
        DispatchQueue.main.async { [weak self] in
            self?.confirmDiscardIfNeeded(operation: "Quit") { [weak self] confirmed in
                guard let self else { return }
                if confirmed { self.stopServerForQuit() }
                else { self.terminationPending = false; sender.reply(toApplicationShouldTerminate: false) }
            }
        }
        return .terminateLater
    }
    private func stopServerForQuit() {
        quitting = true
        readyTimer?.invalidate(); readyTimer = nil
        guard let server, server.isRunning else {
            repliedToQuit = true
            NSApp.reply(toApplicationShouldTerminate: true)
            return
        }
        server.terminate()
        quitTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let child = self?.server, child.isRunning else { return }
                kill(child.processIdentifier, SIGKILL)
            }
        }
    }
    func applicationWillTerminate(_ notification: Notification) {
        readyTimer?.invalidate(); quitTimer?.invalidate()
        for destination in destinations.values { try? FileManager.default.removeItem(at: destination.temporary) }
        if let readyURL { try? FileManager.default.removeItem(at: readyURL) }
        try? serverLog?.close()
    }
    func windowWillClose(_ notification: Notification) {
        if let window = notification.object as? NSWindow, window !== mainWindow {
            children.removeAll { $0 === window }
        }
    }

    private func makeWebView(_ configuration: WKWebViewConfiguration) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        return view
    }
    private func sameOrigin(_ url: URL) -> Bool {
        guard let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }
    private func validLaunchFragment(_ fragment: String?) -> Bool {
        guard let fragment else { return true }
        return fragment.range(of: "^connect=[A-Za-z0-9_-]{20,256}$", options: .regularExpression) != nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if sameOrigin(url) || url.scheme == "blob" || url.absoluteString == "about:blank" {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        } else {
            if ["http", "https"].contains(url.scheme ?? ""), navigationAction.navigationType == .linkActivated {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let attachment = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") ?? false
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil, let url = navigationAction.request.url else { return nil }
        guard sameOrigin(url) else {
            if ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            return nil
        }
        let child = makeWebView(configuration)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Cliptext"
        window.minSize = NSSize(width: 320, height: 240)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = child
        window.center()
        children.append(window)
        window.makeKeyAndOrderFront(nil)
        return child
    }
    func webViewDidClose(_ webView: WKWebView) { webView.window?.close() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showAlert("Cliptext could not load", detail: error.localizedDescription, window: webView.window) }
    }
    private func filePanelWindow(_ candidate: NSWindow?) -> NSWindow {
        let window = candidate ?? mainWindow!
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        return window
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        // The retained interface's sole file input restores a JSON backup.
        // Keep this allowlist explicit rather than inheriting panel filtering.
        panel.allowedContentTypes = [.json]
        panel.allowsOtherFileTypes = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: filePanelWindow(webView.window)) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "Cliptext"; alert.informativeText = message
        alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: webView.window ?? mainWindow) { response in completionHandler(response == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "Cliptext"; alert.informativeText = message; alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: webView.window ?? mainWindow) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { track(download, window: webView.window) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { track(download, window: webView.window) }
    private func track(_ download: WKDownload, window: NSWindow?) {
        let id = ObjectIdentifier(download)
        downloads[id] = download
        downloadWindows[id] = window ?? mainWindow
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        let id = ObjectIdentifier(download)
        panel.beginSheetModal(for: filePanelWindow(downloadWindows[id])) { [weak self] result in
            guard let self else { completionHandler(nil); return }
            guard result == .OK, let chosen = panel.url else { self.clearDownload(id); completionHandler(nil); return }
            do {
                let folder = self.dataURL.appendingPathComponent("downloads", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let temporary = folder.appendingPathComponent(UUID().uuidString + ".partial")
                self.destinations[id] = DownloadDestination(temporary: temporary, final: chosen)
                completionHandler(temporary)
            } catch { completionHandler(nil); self.showAlert("The file could not be saved", detail: error.localizedDescription, window: self.downloadWindows[id]) }
        }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(request.url.map(sameOrigin) == true ? .allow : .cancel)
    }
    func downloadDidFinish(_ download: WKDownload) {
        let id = ObjectIdentifier(download)
        defer { clearDownload(id) }
        guard let destination = destinations[id] else { return }
        let staging = destination.final.deletingLastPathComponent().appendingPathComponent(".cliptext-" + UUID().uuidString + ".partial")
        defer { try? FileManager.default.removeItem(at: staging); try? FileManager.default.removeItem(at: destination.temporary) }
        do {
            try FileManager.default.copyItem(at: destination.temporary, to: staging)
            if FileManager.default.fileExists(atPath: destination.final.path) {
                _ = try FileManager.default.replaceItemAt(destination.final, withItemAt: staging)
            } else { try FileManager.default.moveItem(at: staging, to: destination.final) }
        } catch { showAlert("The file could not be saved", detail: error.localizedDescription, window: downloadWindows[id]) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let id = ObjectIdentifier(download)
        if let destination = destinations[id] { try? FileManager.default.removeItem(at: destination.temporary) }
        if (error as NSError).code != NSURLErrorCancelled { showAlert("The download could not finish", detail: error.localizedDescription, window: downloadWindows[id]) }
        clearDownload(id)
    }
    private func clearDownload(_ id: ObjectIdentifier) { downloads.removeValue(forKey: id); destinations.removeValue(forKey: id); downloadWindows.removeValue(forKey: id) }

    private func confirmDiscardIfNeeded(operation: String, completion: @escaping (Bool) -> Void) {
        guard !checkingDraft else { completion(false); return }
        guard let url = webView.url, sameOrigin(url) else { completion(true); return }
        checkingDraft = true
        // The retained editor/notes handlers only cancel beforeunload when a
        // draft exists. A synthetic cancelable Event checks those same handlers
        // without changing React state or navigating away.
        webView.evaluateJavaScript("!window.dispatchEvent(new Event('beforeunload', {cancelable:true}))") { [weak self] result, error in
            guard let self else { completion(false); return }
            if error == nil, result as? Bool == false {
                self.checkingDraft = false
                completion(true)
                return
            }
            self.mainWindow.makeKeyAndOrderFront(nil)
            let alert = NSAlert()
            alert.messageText = "Discard unsaved changes?"
            alert.informativeText = error == nil ? "Your current draft has not been saved." : "The current draft could not be checked."
            alert.addButton(withTitle: "Discard and \(operation)")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: self.mainWindow) { response in
                self.checkingDraft = false
                completion(response == .alertFirstButtonReturn)
            }
        }
    }
    @objc private func reloadPage() {
        guard origin != nil, !quitting, !terminationPending else { return }
        confirmDiscardIfNeeded(operation: "Reload") { [weak self] confirmed in
            if confirmed { self?.webView.reload() }
        }
    }
    private func installMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Cliptext", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Cliptext", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Cliptext", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); editItem.title = "Edit"; menu.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            let item = edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
            if action == "redo:" { item.keyEquivalent = "z"; item.keyEquivalentModifierMask = [.command, .shift] }
        }
        let viewItem = NSMenuItem(); viewItem.title = "View"; menu.addItem(viewItem)
        let view = NSMenu(title: "View"); viewItem.submenu = view
        let reload = view.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r"); reload.target = self
        let windowItem = NSMenuItem(); windowItem.title = "Window"; menu.addItem(windowItem)
        let window = NSMenu(title: "Window"); windowItem.submenu = window
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.mainMenu = menu
        NSApp.windowsMenu = window
    }
    private func loadingView() -> NSView {
        let view = NSView()
        let spinner = NSProgressIndicator(); spinner.style = .spinning; spinner.controlSize = .regular; spinner.startAnimation(nil)
        let label = NSTextField(labelWithString: "Opening Cliptext…")
        let stack = NSStackView(views: [spinner, label]); stack.orientation = .vertical; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: view.centerXAnchor), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        return view
    }
    private func appError(_ text: String) -> NSError { NSError(domain: "life.cliptext.local", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
    private func showStartupFailure(_ detail: String) {
        guard !quitting && !terminationPending && !startupFailurePresented else { return }
        startupFailurePresented = true
        mainWindow.makeKeyAndOrderFront(nil)
        let alert = NSAlert(); alert.messageText = "Cliptext could not start"; alert.informativeText = detail
        alert.addButton(withTitle: "Quit")
        alert.beginSheetModal(for: mainWindow) { _ in NSApp.terminate(nil) }
    }
    private func showAlert(_ title: String, detail: String, window: NSWindow?) {
        guard !quitting else { return }
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail; alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window ?? mainWindow) { _ in }
    }
}

@main
struct CliptextEntry {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = CliptextAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}

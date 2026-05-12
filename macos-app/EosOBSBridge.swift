import Cocoa

// MARK: - Status

struct BridgeStatus {
    var running: Bool = false
    var eosState: String = "DISCONNECTED"
    var obsEnabled: Bool = false
    var obsConnected: Bool = false
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var bridgeProcess: Process?
    var statusTimer: Timer?
    var currentStatus = BridgeStatus()

    var eosMenuItem: NSMenuItem!
    var obsMenuItem: NSMenuItem!

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()
        ensureConfigExists()
        startBridge()

        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { self.fetchStatus() }
        statusTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in self.fetchStatus() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridgeProcess?.terminate()
    }

    // MARK: First-run config

    func ensureConfigExists() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let configDir = support.appendingPathComponent("Eos OBS Bridge")
        let configFile = configDir.appendingPathComponent("config.json")

        guard !FileManager.default.fileExists(atPath: configFile.path) else { return }

        try? FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)

        if let example = Bundle.main.url(forResource: "config.example", withExtension: "json") {
            try? FileManager.default.copyItem(at: example, to: configFile)
        }
    }

    // MARK: Status bar

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            if #available(macOS 11.0, *) {
                let img = NSImage(systemSymbolName: "antenna.radiowaves.left.and.right",
                                  accessibilityDescription: "Eos OBS Bridge")
                img?.isTemplate = true
                button.image = img
            } else {
                button.title = "EOS"
            }
        }

        buildMenu()
    }

    func buildMenu() {
        let menu = NSMenu()

        let open = NSMenuItem(title: "Open Config UI", action: #selector(openConfigUI), keyEquivalent: "")
        open.target = self
        menu.addItem(open)

        menu.addItem(.separator())

        eosMenuItem = NSMenuItem(title: "Eos: Connecting…", action: nil, keyEquivalent: "")
        eosMenuItem.isEnabled = false
        menu.addItem(eosMenuItem)

        obsMenuItem = NSMenuItem(title: "OBS: —", action: nil, keyEquivalent: "")
        obsMenuItem.isEnabled = false
        menu.addItem(obsMenuItem)

        menu.addItem(.separator())

        let restart = NSMenuItem(title: "Restart Bridge", action: #selector(restartBridge), keyEquivalent: "r")
        restart.target = self
        menu.addItem(restart)

        let quit = NSMenuItem(title: "Quit Eos OBS Bridge", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    func updateMenuStatus() {
        switch currentStatus.eosState {
        case "CONNECTED":
            eosMenuItem.attributedTitle = dot("Eos: Connected", color: .systemGreen)
        case "CONNECTING":
            eosMenuItem.attributedTitle = dot("Eos: Connecting…", color: .systemOrange)
        case "RECONNECTING":
            eosMenuItem.attributedTitle = dot("Eos: Reconnecting…", color: .systemOrange)
        default:
            eosMenuItem.attributedTitle = dot("Eos: Disconnected", color: .systemRed)
        }

        if !currentStatus.obsEnabled {
            obsMenuItem.attributedTitle = NSAttributedString(string: "OBS: Disabled")
        } else if currentStatus.obsConnected {
            obsMenuItem.attributedTitle = dot("OBS: Connected", color: .systemGreen)
        } else {
            obsMenuItem.attributedTitle = dot("OBS: Disconnected", color: .systemRed)
        }
    }

    func dot(_ label: String, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: "● \(label)", attributes: [.foregroundColor: color])
    }

    // MARK: Bridge process

    func bridgeBinaryPath() -> String {
        Bundle.main.url(forResource: "eos-obs-bridge", withExtension: nil)?.path ?? ""
    }

    func startBridge() {
        let path = bridgeBinaryPath()
        guard FileManager.default.fileExists(atPath: path) else { return }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.bridgeProcess = nil }
        }
        try? p.run()
        bridgeProcess = p
    }

    // MARK: Status polling

    func fetchStatus() {
        guard let url = URL(string: "http://127.0.0.1:8082/api/status") else { return }

        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self else { return }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async {
                    self.eosMenuItem.attributedTitle = NSAttributedString(string: "Bridge not running")
                    self.obsMenuItem.attributedTitle = NSAttributedString(string: "")
                }
                return
            }

            var s = BridgeStatus()
            s.running = json["running"] as? Bool ?? false
            if let conn = json["connection"] as? [String: Any] {
                s.eosState = conn["state"] as? String ?? "DISCONNECTED"
            }
            if let obs = json["obs"] as? [String: Any] {
                s.obsEnabled = obs["enabled"] as? Bool ?? false
                s.obsConnected = obs["connected"] as? Bool ?? false
            }

            DispatchQueue.main.async {
                self.currentStatus = s
                self.updateMenuStatus()
            }
        }.resume()
    }

    // MARK: Actions

    @objc func openConfigUI() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8082/")!)
    }

    @objc func restartBridge() {
        bridgeProcess?.terminate()
        bridgeProcess = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.startBridge() }
    }

    @objc func quitApp() {
        bridgeProcess?.terminate()
        NSApp.terminate(nil)
    }
}

// MARK: - Entry point

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // menu bar only, no Dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()

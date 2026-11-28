// Read and write single keys of a JSON config file shared with a Node CLI (the CLI owns the schema).
// Nothing is cached: every read re-parses the file, every write is a read-modify-write of one key, so
// keys this app doesn't know about are kept.
//
// API
//   JSONConfigFile(path:)          Absolute path ("~" is expanded), e.g. "~/.config/<app>/config.json".
//   .path                          The expanded path.
//   .dict() -> [String: Any]       The whole file ([:] when missing or unreadable).
//   .string(key, default)          String value; empty or missing -> default.
//   .int(key, default)             Int value; missing or not a number -> default.
//   .bool(key, default)            "on" -> true, any other string -> false, missing -> default.
//   .set(key, value)               Write one key (creates the parent directory; pretty-printed, sorted keys).
//   .setBool(key, on)              Writes "on" / "off".
import Foundation

struct JSONConfigFile {
    let path: String

    init(path: String) { self.path = NSString(string: path).expandingTildeInPath }

    func dict() -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: path),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return json
    }

    func string(_ key: String, _ def: String) -> String { (dict()[key] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? def }
    func int(_ key: String, _ def: Int) -> Int { (dict()[key] as? Int) ?? def }
    func bool(_ key: String, _ def: Bool) -> Bool {
        guard let v = dict()[key] as? String else { return def }
        return v == "on"
    }

    /// Read-modify-write a single key, preserving everything else the CLI has stored.
    func set(_ key: String, _ value: Any) {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        var json = ((try? JSONSerialization.jsonObject(with: fm.contents(atPath: path) ?? Data())) as? [String: Any]) ?? [:]
        json[key] = value
        if let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    func setBool(_ key: String, _ on: Bool) { set(key, on ? "on" : "off") }
}

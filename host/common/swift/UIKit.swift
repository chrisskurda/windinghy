// Shared SwiftUI building blocks for the Dinghy menu-bar apps (compiled into each app with plain swiftc;
// no module, no product strings here).
//
// API
//   Box<T>                     Observable value holder; use `@StateObject private var x = Box(v)` in place
//                              of `@State` (a macro that Command Line Tools swiftc can't expand).
//   Card(padding: 16) { … }    Content on a rounded (radius 10) .quaternary panel, full width, leading.
//                              Card(padding: 4) wraps lists of rows; Card(padding: 18) is a header card.
//   StatusDot(ok:)             8 pt circle: green when ok, else faint secondary.
//   Metric(label:value:fraction:)  Card with a 12 pt label, a 22 pt value and a linear bar (fraction
//                              clamped to 0...1).
//   SliderRow(title:value:range:step:display:note:)  Form row: title + display text, an Int slider, a
//                              12 pt secondary note.
//   KV(_ key, _ value)         Form row: key on the left, value in 12 pt monospaced secondary on the right.
//   Row(_ title, _ detail)     Title over a 12 pt secondary detail line.
//   note(_ text, warn:)        12 pt Label: orange warning triangle when warn, else secondary info circle.
import SwiftUI

/// Small observable value holder. `@State` is a macro in recent SDKs and needs the SwiftUI macro plugin,
/// which isn't in the Command Line Tools; `@StateObject` + this box needs nothing extra.
final class Box<T>: ObservableObject {
    @Published var value: T
    init(_ v: T) { value = v }
}

struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary))
    }
}

struct StatusDot: View {
    let ok: Bool
    var body: some View { Circle().fill(ok ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8) }
}

struct Metric: View {
    let label: String, value: String, fraction: Double
    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                Text(label).font(.system(size: 12)).foregroundStyle(.secondary)
                Text(value).font(.system(size: 22, weight: .semibold))
                ProgressView(value: min(max(fraction, 0), 1)).progressViewStyle(.linear)
            }
        }
    }
}

struct SliderRow: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    let step: Int
    let display: String
    let note: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Text(title); Spacer(); Text(display).foregroundStyle(.secondary) }
            Slider(value: Binding(get: { Double(value) }, set: { value = Int($0) }),
                   in: Double(range.lowerBound)...Double(range.upperBound), step: Double(step))
            Text(note).font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

struct KV: View {
    let k: String, v: String
    init(_ k: String, _ v: String) { self.k = k; self.v = v }
    var body: some View {
        HStack { Text(k); Spacer(); Text(v).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary) }
    }
}

struct Row: View {
    let title: String, detail: String
    init(_ t: String, _ d: String) { title = t; detail = d }
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }
}

/// An inline hint under a form control: a warning (orange triangle) or plain information.
@ViewBuilder func note(_ text: String, warn: Bool) -> some View {
    Label(text, systemImage: warn ? "exclamationmark.triangle.fill" : "info.circle")
        .font(.system(size: 12)).foregroundStyle(warn ? Color.orange : Color.secondary)
}

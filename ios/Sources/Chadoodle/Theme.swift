// Gestaltung wie Desktop und Website: Farbschema „Graphit & Petrol“.
//   pDark  #1B1F27  Text, dunkle Flächen
//   pMid   #56637A  Nebeninfos, Linien
//   pLight #F2F4F7  Hintergrund, helle Flächen
//   accent #0E7C86  Bedienelemente, Auswahl, „Neu“ (im Dunkelmodus #4FC1C9)
import SwiftUI
import UIKit

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }

    static func adaptive(_ light: UIColor, _ dark: UIColor) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }

    // Mischung zweier Farben (t = Anteil von b)
    func mixed(_ b: UIColor, _ t: CGFloat) -> UIColor {
        var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
        var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
        getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r1 + (r2 - r1) * t, green: g1 + (g2 - g1) * t, blue: b1 + (b2 - b1) * t, alpha: 1)
    }
}

private let uDark = UIColor(hex: 0x1B1F27)
private let uMid = UIColor(hex: 0x56637A)
private let uLight = UIColor(hex: 0xF2F4F7)
private let uAcc = UIColor(hex: 0x0E7C86)
private let uAccDark = UIColor(hex: 0x4FC1C9)

extension Color {
    static let pDark = Color(uiColor: uDark)
    static let pMid = Color(uiColor: uMid)
    static let pLight = Color(uiColor: uLight)
    // Schrift/Aktion: dunkel im hellen Modus, hell im dunklen
    static let ink = Color(uiColor: .adaptive(uDark, uLight))
    // Schrift auf einer ink-Fläche
    static let onInk = Color(uiColor: .adaptive(uLight, uDark))
    static let inkSecondary = Color(uiColor: .adaptive(uMid, uMid.mixed(uLight, 0.45)))
    // Akzent (Petrol) und Schrift darauf
    static let accent = Color(uiColor: .adaptive(uAcc, uAccDark))
    static let onAccent = Color(uiColor: .adaptive(.white, UIColor(hex: 0x0B1417)))
    // Flächen
    static let appBackground = Color(uiColor: .adaptive(uLight, uDark.mixed(.black, 0.28)))
    static let cardBackground = Color(uiColor: .adaptive(.white, uDark))
    static let softFill = Color(uiColor: .adaptive(uMid.mixed(.white, 0.86), uDark.mixed(uMid, 0.2)))
    // Drei Abstufungen für Kurskarten (wie die „Classes“-Karten der Vorlage)
    static let shade0 = Color(uiColor: .adaptive(uDark, uDark.mixed(uMid, 0.22)))
    static let shade1 = Color(uiColor: .adaptive(uAcc, uAcc.mixed(uDark, 0.2)))
    static let shade2 = Color(uiColor: .adaptive(uMid.mixed(uDark, 0.22), uDark.mixed(uMid, 0.72)))
}

// Akzent für alle Bedienelemente
let brand = Color.accent

// Fläche + Schrift für Vorlesungen/Kurse: drei helle Varianten (im Raster wirkt Dunkel zu schwer)
struct Shade {
    let fill: Color
    let text: Color
    let stroke: Color?

    static let all: [Shade] = [
        Shade(fill: Color(uiColor: .adaptive(uMid.mixed(.white, 0.76), uDark.mixed(uMid, 0.3))), text: .ink, stroke: nil),
        Shade(fill: Color(uiColor: .adaptive(uLight, uDark.mixed(uMid, 0.12))), text: .ink, stroke: Color(uiColor: .adaptive(uMid.mixed(.white, 0.45), uMid.mixed(uDark, 0.5)))),
        Shade(fill: Color(uiColor: .adaptive(uMid.mixed(.white, 0.52), uDark.mixed(uMid, 0.5))), text: .ink, stroke: nil),
    ]
}

// Gleiche Vorlesung → gleiche Abstufung (Dozentenkürzel „(HiC)“ zählt nicht mit), wie ttColor im Web
func lectureShade(_ title: String) -> Shade {
    let base = title.replacingOccurrences(of: "\\(.*$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces).lowercased()
    var h: UInt32 = 0
    for u in base.utf16 { h = (h &* 31 &+ UInt32(u)) }
    return Shade.all[Int(h % 3)]
}

// Ältere Aufrufer erwarten eine einzelne Farbe (Punkte, Fortschritt): immer die Akzentfarbe
func lectureColor(_ title: String) -> Color { .ink }

extension View {
    // Flache weiße Karte auf hellgrauem Grund wie auf Desktop/Website
    func card(padding: CGFloat = 0) -> some View {
        self.padding(padding).background(Color.cardBackground, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    func appBackground() -> some View {
        background(Color.appBackground.ignoresSafeArea())
    }
}

// Kleine Pille (z. B. „Jetzt“, Status)
struct Pill: View {
    let text: String
    var filled = true
    var systemImage: String?

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage) }
            Text(text)
        }
        .font(.caption2.weight(.bold))
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(filled ? Color.ink : Color.softFill, in: Capsule())
        .foregroundStyle(filled ? Color.onInk : Color.ink)
    }
}

// Abschnittskopf mit „Alle ansehen“-Knopf wie in der Vorlage
struct SectionHeader: View {
    let title: String
    var action: String?
    var onAction: (() -> Void)?

    init(_ title: String, action: String? = nil, onAction: (() -> Void)? = nil) {
        self.title = title
        self.action = action
        self.onAction = onAction
    }

    var body: some View {
        HStack(alignment: .center) {
            Text(title).font(.headline)
            Spacer()
            if let action, let onAction {
                Button(action: onAction) {
                    HStack(spacing: 3) {
                        Text(action)
                        Image(systemName: "chevron.right").font(.caption2.bold())
                    }
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Color.cardBackground, in: RoundedRectangle(cornerRadius: 9))
                    .foregroundStyle(Color.inkSecondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 2)
    }
}

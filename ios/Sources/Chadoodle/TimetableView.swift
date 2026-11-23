// Stundenplan im Stil eines ruhigen Kalenders: Wochenleiste oben (heute dunkel hinterlegt), darunter der Tag
// als Zeitraster mit hellen Terminblöcken und dunkler Jetzt-Linie. Wischen wechselt Tag bzw. Woche.
// Stunden lassen sich als Vorschlag verschieben – auf jeden Tag, jede Woche und jede Uhrzeit, nur nicht in
// die Vergangenheit; schon begonnene Stunden bleiben fest.
import SwiftUI

private var berlinCal: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.locale = deLocale
    c.firstWeekday = 2
    return c
}

func lectureTitle(_ title: String) -> String {
    title.replacingOccurrences(of: "\\s*\\([A-ZÄÖÜ][A-Za-zÄÖÜäöü]{1,3}\\)\\s*$", with: "", options: .regularExpression)
}

// Termin im Raster: normal, verschoben (an der neuen Stelle) oder Platzhalter an der alten Stelle
struct PlacedEvent: Identifiable {
    enum Kind { case normal, moved, ghost }
    let event: TTEvent
    let kind: Kind
    let start: Date
    let end: Date
    var id: String { "\(event.id)#\(kind)" }
}

struct TimetableView: View {
    @EnvironmentObject private var tt: Timetables
    @State private var day = berlinCal.startOfDay(for: Date())
    @State private var showAdd = false
    @State private var picked: TTEvent?
    @State private var forward = true
    @State private var showProposal = false
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                WeekStrip(day: $day, forward: $forward)
                if tt.active == nil {
                    ContentUnavailableView {
                        Label("Kein Stundenplan", systemImage: "calendar.badge.plus")
                    } description: {
                        Text("Füge einen Rapla- oder iCal-Link hinzu.")
                    } actions: {
                        Button("Stundenplan hinzufügen") { showAdd = true }.buttonStyle(.borderedProminent)
                    }
                } else {
                    DayTimeline(day: day, items: placed(day)) { picked = $0 }
                        .id(day)
                        .transition(.asymmetric(insertion: .move(edge: forward ? .trailing : .leading), removal: .move(edge: forward ? .leading : .trailing)).combined(with: .opacity))
                        .gesture(DragGesture(minimumDistance: 30).onEnded { v in
                            guard abs(v.translation.width) > abs(v.translation.height) * 1.4 else { return }
                            step(v.translation.width < 0 ? 1 : -1)
                        })
                }
            }
            .background(Color.cardBackground)
            .safeAreaInset(edge: .bottom) {
                let n = tt.moves().count
                if n > 0 {
                    HStack(spacing: 12) {
                        Image(systemName: "arrow.left.arrow.right")
                        VStack(alignment: .leading, spacing: 1) {
                            Text(n == 1 ? "1 Stunde verschoben" : "\(n) Stunden verschoben").font(.subheadline.bold())
                            Text("Nur ein Vorschlag – dein Plan bleibt gleich").font(.caption).opacity(0.8)
                        }
                        Spacer()
                        Button("Senden") { showProposal = true }
                            .font(.subheadline.bold())
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(Color.onInk, in: Capsule())
                            .foregroundStyle(Color.ink)
                    }
                    .foregroundStyle(Color.onInk)
                    .padding(12)
                    .background(Color.ink, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .padding(.horizontal).padding(.bottom, 6)
                    .contextMenu { Button("Alle Verschiebungen verwerfen", role: .destructive) { tt.resetMoves() } }
                }
            }
            .navigationTitle(day.formatted(.dateTime.month(.wide).year().locale(deLocale)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Heute") { go(berlinCal.startOfDay(for: Date())) }
                        .disabled(berlinCal.isDateInToday(day))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Stundenplan", selection: $tt.activeId) {
                            ForEach(tt.list) { t in Text(t.name).tag(t.id) }
                        }
                        Button { Task { await tt.refreshAll() } } label: { Label("Aktualisieren", systemImage: "arrow.clockwise") }
                        Button { showAdd = true } label: { Label("Stundenplan hinzufügen", systemImage: "plus") }
                        if !tt.moves().isEmpty {
                            Button { showProposal = true } label: { Label("Vorschlag senden", systemImage: "envelope") }
                            Button(role: .destructive) { tt.resetMoves() } label: { Label("Verschiebungen verwerfen", systemImage: "arrow.uturn.backward") }
                        }
                        if let a = tt.active, let c = tt.caches[a.id] {
                            Section("Stand \(relTime(c.fetchedAt))") {}
                        }
                    } label: {
                        if tt.loading { ProgressView() } else { Image(systemName: "ellipsis.circle") }
                    }
                }
            }
            .sheet(isPresented: $showAdd) { AddTimetableView() }
            .sheet(isPresented: $showProposal) { ProposalSheet() }
            .sheet(item: $picked) { e in
                LectureDetail(event: e) { d in
                    picked = nil
                    go(berlinCal.startOfDay(for: d))
                } openCourse: { id in
                    picked = nil
                    path.append(Route.course(id))
                }
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            .withRoutes()
        }
    }

    // Termine eines Tages inklusive Verschiebungen (auch aus anderen Wochen hierher)
    private func placed(_ d: Date) -> [PlacedEvent] {
        let next = berlinCal.date(byAdding: .day, value: 1, to: d)!
        let moves = tt.moves()
        var out: [PlacedEvent] = []
        var seen = Set<String>()
        for e in tt.events(tt.active?.id, from: d, to: next) where e.start < next && e.end > d {
            seen.insert(e.id)
            if let m = moves[e.id] {
                out.append(PlacedEvent(event: e, kind: .ghost, start: e.start, end: e.end))
                if m.newStart >= d && m.newStart < next { out.append(PlacedEvent(event: e, kind: .moved, start: m.newStart, end: m.newEnd)) }
            } else {
                out.append(PlacedEvent(event: e, kind: .normal, start: e.start, end: e.end))
            }
        }
        for m in moves.values where !seen.contains(m.id) && m.newStart >= d && m.newStart < next {
            out.append(PlacedEvent(event: m.asEvent, kind: .moved, start: m.newStart, end: m.newEnd))
        }
        return out
    }

    private func step(_ n: Int) {
        go(berlinCal.date(byAdding: .day, value: n, to: day)!)
    }

    private func go(_ d: Date) {
        forward = d > day
        withAnimation(.snappy) { day = d }
    }
}

// ---------- Wochenleiste ----------
struct WeekStrip: View {
    @EnvironmentObject private var tt: Timetables
    @Binding var day: Date
    @Binding var forward: Bool

    var body: some View {
        let start = berlinCal.dateInterval(of: .weekOfYear, for: day)!.start
        let days = (0..<7).map { berlinCal.date(byAdding: .day, value: $0, to: start)! }
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(days, id: \.self) { d in
                    let sel = berlinCal.isDate(d, inSameDayAs: day)
                    let today = berlinCal.isDateInToday(d)
                    let has = !tt.events(tt.active?.id, from: d, to: berlinCal.date(byAdding: .day, value: 1, to: d)!).filter { !$0.allDay }.isEmpty
                    Button {
                        forward = d > day
                        withAnimation(.snappy) { day = d }
                    } label: {
                        VStack(spacing: 3) {
                            Text(d.formatted(.dateTime.weekday(.abbreviated).locale(deLocale)))
                                .font(.caption2.weight(.semibold))
                            Text(d.formatted(.dateTime.day()))
                                .font(.callout.weight(sel || today ? .bold : .regular))
                            Circle().fill(has ? (sel ? Color.onInk : Color.pMid) : .clear).frame(width: 4, height: 4)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(sel ? Color.ink : today ? Color.softFill : .clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .foregroundStyle(sel ? Color.onInk : berlinCal.isDateInWeekend(d) ? Color.pMid : Color.ink)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(day.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(deLocale)))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.inkSecondary)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .background(Color.cardBackground)
        .overlay(alignment: .bottom) { Divider() }
        .gesture(DragGesture(minimumDistance: 30).onEnded { v in
            guard abs(v.translation.width) > abs(v.translation.height) else { return }
            let n = v.translation.width < 0 ? 7 : -7
            forward = n > 0
            withAnimation(.snappy) { day = berlinCal.date(byAdding: .day, value: n, to: day)! }
        })
    }
}

// ---------- Tag als Zeitraster ----------
struct DayTimeline: View {
    let day: Date
    let items: [PlacedEvent]
    let onTap: (TTEvent) -> Void

    private let hourHeight: CGFloat = 60
    private let gutter: CGFloat = 52

    var body: some View {
        let timed = items.filter { !$0.event.allDay }
        let allDay = items.filter(\.event.allDay)
        VStack(spacing: 0) {
            if !allDay.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(allDay) { p in
                        Button { onTap(p.event) } label: {
                            Text(lectureTitle(p.event.title)).font(.caption.weight(.semibold)).lineLimit(1)
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.softFill, in: RoundedRectangle(cornerRadius: 8))
                                .foregroundStyle(Color.ink)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.leading, gutter).padding(.trailing, 12).padding(.vertical, 6)
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    ZStack(alignment: .topLeading) {
                        grid
                        TimelineView(.everyMinute) { ctx in
                            if berlinCal.isDate(ctx.date, inSameDayAs: day) { pastShade(ctx.date) }
                            else if day < ctx.date { Color.pMid.opacity(0.06).frame(height: hourHeight * 24).padding(.leading, gutter) }
                        }
                        blocks(timed)
                        TimelineView(.everyMinute) { ctx in
                            if berlinCal.isDate(ctx.date, inSameDayAs: day) { nowLine(ctx.date) }
                        }
                    }
                    .frame(height: hourHeight * 24)
                    .padding(.vertical, 10)
                }
                .overlay {
                    if timed.isEmpty && allDay.isEmpty {
                        VStack(spacing: 6) {
                            Image(systemName: berlinCal.isDateInWeekend(day) ? "sun.max" : "cup.and.saucer").font(.largeTitle).foregroundStyle(Color.pMid)
                            Text("Keine Vorlesungen").font(.headline).foregroundStyle(Color.inkSecondary)
                        }
                        .padding(24)
                        .background(Color.appBackground, in: RoundedRectangle(cornerRadius: 18))
                    }
                }
                .onAppear {
                    let first = timed.map { berlinCal.component(.hour, from: $0.start) }.min()
                    let now = berlinCal.isDateInToday(day) ? berlinCal.component(.hour, from: Date()) - 1 : nil
                    proxy.scrollTo(max(0, min(first ?? 7, now ?? 24, 20) - 1), anchor: .top)
                }
            }
        }
    }

    private var grid: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { h in
                HStack(alignment: .top, spacing: 6) {
                    Text(String(format: "%02d:00", h))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Color.inkSecondary)
                        .frame(width: gutter - 8, alignment: .trailing)
                        .offset(y: -7)
                    VStack { Divider() }
                }
                .frame(height: hourHeight, alignment: .top)
                .id(h)
            }
        }
    }

    private func y(_ d: Date) -> CGFloat {
        let c = berlinCal.dateComponents([.hour, .minute], from: d)
        let mins = berlinCal.isDate(d, inSameDayAs: day) ? CGFloat(c.hour! * 60 + c.minute!) : (d < day ? 0 : 24 * 60)
        return mins / 60 * hourHeight
    }

    // Vergangener Teil des Tages leicht hinterlegt: dorthin lässt sich nichts verschieben
    private func pastShade(_ now: Date) -> some View {
        Color.pMid.opacity(0.06).frame(height: y(now)).padding(.leading, gutter)
    }

    private func nowLine(_ now: Date) -> some View {
        HStack(spacing: 0) {
            Text(now.formatted(date: .omitted, time: .shortened))
                .font(.caption2.bold().monospacedDigit())
                .foregroundStyle(Color.onInk)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(Color.ink, in: Capsule())
                .frame(width: gutter - 2, alignment: .trailing)
            Rectangle().fill(Color.ink).frame(height: 1.5)
        }
        .offset(y: y(now) - 9)
    }

    // Überschneidungen nebeneinander (gierige Spaltenverteilung)
    private func blocks(_ list: [PlacedEvent]) -> some View {
        let sorted = list.sorted { $0.start < $1.start }
        var columns: [[PlacedEvent]] = []
        var colOf: [String: Int] = [:]
        for e in sorted {
            if let i = columns.firstIndex(where: { $0.last!.end <= e.start }) {
                columns[i].append(e)
                colOf[e.id] = i
            } else {
                columns.append([e])
                colOf[e.id] = columns.count - 1
            }
        }
        let n = max(1, columns.count)
        return GeometryReader { geo in
            let width = (geo.size.width - gutter - 8) / CGFloat(n)
            ForEach(sorted) { p in
                let top = y(p.start)
                let h = max(26, y(p.end) - top - 3)
                EventBlock(placed: p, compact: h < 50)
                    .frame(width: width - 4, height: h)
                    .offset(x: gutter + CGFloat(colOf[p.id] ?? 0) * width, y: top + 1)
                    .onTapGesture { if p.kind != .ghost { onTap(p.event) } }
            }
        }
    }
}

struct EventBlock: View {
    let placed: PlacedEvent
    var compact = false

    var body: some View {
        TimelineView(.everyMinute) { ctx in block(ctx.date) }
    }

    private func block(_ now: Date) -> some View {
        let s = lectureShade(placed.event.title)
        let running = placed.kind != .ghost && placed.start <= now && placed.end > now
        let ghost = placed.kind == .ghost
        return VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if running { Circle().fill(Color.ink).frame(width: 6, height: 6) }
                Text(lectureTitle(placed.event.title)).font(.caption.weight(.semibold)).lineLimit(compact ? 1 : 2)
                    .strikethrough(ghost)
                Spacer(minLength: 0)
                if placed.kind == .moved && !compact { Pill(text: "Vorschlag", filled: false) }
            }
            if !compact {
                Text("\(placed.start.formatted(date: .omitted, time: .shortened)) – \(placed.end.formatted(date: .omitted, time: .shortened))")
                    .font(.caption2.monospacedDigit()).opacity(0.75)
                if !placed.event.location.isEmpty && !ghost {
                    Text(placed.event.location).font(.caption2).opacity(0.75).lineLimit(1)
                }
            }
        }
        .foregroundStyle(ghost ? Color.inkSecondary : s.text)
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(ghost ? Color.clear : s.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(ghost ? Color.pMid : running || placed.kind == .moved ? Color.ink : (s.stroke ?? .clear),
                              style: StrokeStyle(lineWidth: ghost ? 1.2 : running || placed.kind == .moved ? 1.8 : 1, dash: ghost ? [4, 3] : []))
        }
        .opacity(placed.kind == .normal && placed.end < now ? 0.5 : 1)
    }
}

struct LectureDetail: View {
    @EnvironmentObject private var tt: Timetables
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    let event: TTEvent
    let onMoved: (Date) -> Void
    let openCourse: (Int) -> Void
    @State private var target = Date()
    @State private var error: String?

    var body: some View {
        let move = tt.moves()[event.id]
        let current = move?.newStart ?? event.start
        let locked = current <= Date()
        let course = courseFor(event.title, in: app.cache.courses)
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(lectureTitle(event.title)).font(.title3.bold())
                        Text(event.start.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(deLocale)))
                            .foregroundStyle(Color.inkSecondary)
                        Text(event.allDay ? "ganztägig" : "\(event.start.formatted(date: .omitted, time: .shortened)) – \(event.end.formatted(date: .omitted, time: .shortened)) Uhr")
                            .foregroundStyle(Color.inkSecondary)
                    }
                    .listRowBackground(Color.clear)
                }
                if let move {
                    Section("Vorschlag") {
                        Label(ttSpan(move.newStart, move.newEnd), systemImage: "arrow.left.arrow.right")
                        Button("Verschiebung zurücknehmen", role: .destructive) { tt.undoMove(event.id); dismiss() }
                    }
                }
                Section {
                    if !event.location.isEmpty { Label(event.location, systemImage: "mappin.and.ellipse") }
                    if !event.persons.isEmpty { Label(event.persons.joined(separator: ", "), systemImage: "person.fill") }
                    if !event.allDay {
                        let mins = Int(event.end.timeIntervalSince(event.start) / 60)
                        Label("\(mins / 60) h \(mins % 60) min", systemImage: "clock")
                    }
                    if let course {
                        Button { openCourse(course.id) } label: { Label(course.fullname, systemImage: "book.closed") }
                    }
                }
                if event.elapsed() != nil {
                    TimelineView(.periodic(from: .now, by: 10)) { ctx in
                        let p = event.elapsed(at: ctx.date) ?? 1
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("\(Int(p * 100)) % vorbei").fontWeight(.semibold)
                                Spacer()
                                Text("noch \(Int(ceil(event.end.timeIntervalSince(ctx.date) / 60))) min").foregroundStyle(Color.inkSecondary)
                            }
                            .font(.subheadline.monospacedDigit())
                            ProgressView(value: p).tint(Color.ink)
                        }
                    }
                }
                if !event.allDay {
                    Section {
                        if locked {
                            Label("Hat schon begonnen – lässt sich nicht mehr verschieben.", systemImage: "lock").foregroundStyle(Color.inkSecondary)
                        } else {
                            DatePicker("Neuer Beginn", selection: $target, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                                .environment(\.locale, deLocale)
                            Button {
                                let t = rounded(target)
                                guard t > Date() else { error = "Der neue Termin liegt in der Vergangenheit."; return }
                                tt.move(event, to: t)
                                onMoved(t)
                            } label: { Label("Verschieben", systemImage: "arrow.left.arrow.right") }
                            if let error { Text(error).font(.caption).foregroundStyle(Color.ink) }
                        }
                    } header: { Text("Verschieben (Vorschlag)") } footer: {
                        Text("Jeder Tag, jede Woche und jede Uhrzeit, nur nicht in der Vergangenheit. Die Dauer bleibt gleich; dein Plan ändert sich nicht – du kannst den Vorschlag danach per Mail an den Kurssprecher senden.")
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { target = max(current, rounded(Date().addingTimeInterval(15 * 60))) }
        }
    }

    // Auf 15 Minuten runden
    private func rounded(_ d: Date) -> Date {
        let t = (d.timeIntervalSince1970 / 900).rounded() * 900
        return Date(timeIntervalSince1970: t)
    }
}

// Kompakte Zeile für die Startseite
struct LectureRow: View {
    let event: TTEvent

    var body: some View {
        let now = !event.allDay && event.start <= Date() && event.end > Date()
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 2).fill(lectureShade(event.title).fill).frame(width: 4, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(lectureTitle(event.title)).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text([event.allDay ? "ganztägig" : "\(event.start.formatted(date: .omitted, time: .shortened)) – \(event.end.formatted(date: .omitted, time: .shortened))",
                      event.location].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Color.inkSecondary).lineLimit(1)
            }
            Spacer()
            if now { Pill(text: "Jetzt") }
        }
    }
}

struct AddTimetableView: View {
    @EnvironmentObject private var tt: Timetables
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name (z. B. TSA25)", text: $name)
                    TextField("Rapla- oder iCal-Link", text: $url)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                } footer: {
                    Text("Rapla-Ansichtslinks, https://…/.ics und webcal://-Links funktionieren.")
                }
                if !tt.list.contains(where: { $0.url == raplaTemplate.url }) {
                    Section {
                        Button("Vorlage: \(raplaTemplate.name)") {
                            name = raplaTemplate.name
                            url = raplaTemplate.url
                        }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(Color.ink) } }
            }
            .navigationTitle("Stundenplan hinzufügen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button("Hinzufügen") {
                            Task {
                                busy = true
                                defer { busy = false }
                                do {
                                    try await tt.add(name: name, url: url)
                                    dismiss()
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                        .disabled(url.isEmpty)
                    }
                }
            }
        }
    }
}

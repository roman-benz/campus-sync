// Stundenplan im Stil der Kalender-App: Wochenleiste oben, darunter der Tag als Zeitraster mit
// farbigen Terminblöcken und roter Jetzt-Linie. Wischen wechselt Tag bzw. Woche.
import SwiftUI

private var berlinCal: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.locale = deLocale
    c.firstWeekday = 2
    return c
}

// Gleiche Vorlesung → gleiche Farbe (Dozierenden-Kürzel „(HiC)“ zählt nicht mit)
func lectureColor(_ title: String) -> Color {
    let key = title.replacingOccurrences(of: "\\s*\\([^)]*\\)\\s*$", with: "", options: .regularExpression)
    let palette: [Color] = [.blue, .orange, .green, .purple, .pink, .teal, .indigo, .red, .mint, .brown, .cyan, .yellow]
    let h = key.unicodeScalars.reduce(UInt32(5381)) { ($0 << 5) &+ $0 &+ $1.value }
    return palette[Int(h % UInt32(palette.count))]
}

func lectureTitle(_ title: String) -> String {
    title.replacingOccurrences(of: "\\s*\\([A-ZÄÖÜ][A-Za-zÄÖÜäöü]{1,3}\\)\\s*$", with: "", options: .regularExpression)
}

struct TimetableView: View {
    @EnvironmentObject private var tt: Timetables
    @State private var day = berlinCal.startOfDay(for: Date())
    @State private var showAdd = false
    @State private var picked: TTEvent?
    @State private var forward = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                WeekStrip(day: $day, forward: $forward)
                Divider()
                if tt.active == nil {
                    ContentUnavailableView {
                        Label("Kein Stundenplan", systemImage: "calendar.badge.plus")
                    } description: {
                        Text("Füge einen Rapla- oder iCal-Link hinzu.")
                    } actions: {
                        Button("Stundenplan hinzufügen") { showAdd = true }.buttonStyle(.borderedProminent)
                    }
                } else {
                    DayTimeline(day: day, events: events(day)) { picked = $0 }
                        .id(day)
                        .transition(.asymmetric(insertion: .move(edge: forward ? .trailing : .leading), removal: .move(edge: forward ? .leading : .trailing)).combined(with: .opacity))
                        .gesture(DragGesture(minimumDistance: 30).onEnded { v in
                            guard abs(v.translation.width) > abs(v.translation.height) * 1.4 else { return }
                            step(v.translation.width < 0 ? 1 : -1)
                        })
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
                        if let a = tt.active, let c = tt.caches[a.id] {
                            Section("Stand \(relTime(c.fetchedAt))") {}
                        }
                    } label: {
                        if tt.loading { ProgressView() } else { Image(systemName: "ellipsis.circle") }
                    }
                }
            }
            .sheet(isPresented: $showAdd) { AddTimetableView() }
            .sheet(item: $picked) { e in
                LectureDetail(event: e).presentationDetents([.medium]).presentationDragIndicator(.visible)
            }
        }
    }

    private func events(_ d: Date) -> [TTEvent] {
        let next = berlinCal.date(byAdding: .day, value: 1, to: d)!
        return tt.events(tt.active?.id, from: d, to: next).filter { $0.start < next && $0.end > d }
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
        VStack(spacing: 6) {
            HStack(spacing: 0) {
                ForEach(days, id: \.self) { d in
                    let sel = berlinCal.isDate(d, inSameDayAs: day)
                    let today = berlinCal.isDateInToday(d)
                    let has = !tt.events(tt.active?.id, from: d, to: berlinCal.date(byAdding: .day, value: 1, to: d)!).filter { !$0.allDay }.isEmpty
                    Button {
                        forward = d > day
                        withAnimation(.snappy) { day = d }
                    } label: {
                        VStack(spacing: 4) {
                            Text(d.formatted(.dateTime.weekday(.narrow).locale(deLocale)))
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(berlinCal.isDateInWeekend(d) ? .tertiary : .secondary)
                            Text(d.formatted(.dateTime.day()))
                                .font(.body.weight(sel || today ? .semibold : .regular))
                                .frame(width: 36, height: 36)
                                .background(Circle().fill(sel ? (today ? Color.red : Color.primary) : .clear))
                                .foregroundStyle(sel ? Color(.systemBackground) : today ? .red : .primary)
                            Circle().fill(has ? Color.secondary : .clear).frame(width: 5, height: 5)
                        }
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(day.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(deLocale)))
                .font(.subheadline.weight(.medium))
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .background(.bar)
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
    let events: [TTEvent]
    let onTap: (TTEvent) -> Void

    private let hourHeight: CGFloat = 60
    private let gutter: CGFloat = 52

    var body: some View {
        let timed = events.filter { !$0.allDay }
        let allDay = events.filter(\.allDay)
        VStack(spacing: 0) {
            if !allDay.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(allDay) { e in
                        Button { onTap(e) } label: {
                            Text(lectureTitle(e.title)).font(.caption.weight(.semibold)).lineLimit(1)
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(lectureColor(e.title).opacity(0.2), in: RoundedRectangle(cornerRadius: 6))
                                .foregroundStyle(lectureColor(e.title))
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
                            if berlinCal.isDate(ctx.date, inSameDayAs: day) { nowLine(ctx.date) }
                        }
                        blocks(timed)
                    }
                    .frame(height: hourHeight * 24)
                    .padding(.vertical, 10)
                }
                .overlay {
                    if timed.isEmpty && allDay.isEmpty {
                        VStack(spacing: 6) {
                            Image(systemName: berlinCal.isDateInWeekend(day) ? "sun.max" : "cup.and.saucer").font(.largeTitle).foregroundStyle(.tertiary)
                            Text("Keine Vorlesungen").font(.headline).foregroundStyle(.secondary)
                        }
                        .padding(24)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
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
                        .foregroundStyle(.secondary)
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

    private func nowLine(_ now: Date) -> some View {
        HStack(spacing: 0) {
            Text(now.formatted(date: .omitted, time: .shortened))
                .font(.caption2.bold().monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 4).padding(.vertical, 1)
                .background(Color.red, in: Capsule())
                .frame(width: gutter - 2, alignment: .trailing)
            Rectangle().fill(Color.red).frame(height: 1.5)
        }
        .offset(y: y(now) - 8)
    }

    // Überschneidungen nebeneinander (gierige Spaltenverteilung)
    private func blocks(_ list: [TTEvent]) -> some View {
        let sorted = list.sorted { $0.start < $1.start }
        var columns: [[TTEvent]] = []
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
            ForEach(sorted) { e in
                let top = y(e.start)
                let h = max(24, y(e.end) - top - 2)
                EventBlock(event: e, compact: h < 48)
                    .frame(width: width - 3, height: h)
                    .offset(x: gutter + CGFloat(colOf[e.id] ?? 0) * width, y: top + 1)
                    .onTapGesture { onTap(e) }
            }
        }
    }
}

struct EventBlock: View {
    let event: TTEvent
    var compact = false

    var body: some View {
        TimelineView(.everyMinute) { ctx in block(ctx.date) }
    }

    private func block(_ now: Date) -> some View {
        let c = lectureColor(event.title)
        let elapsed = event.elapsed(at: now)
        let running = elapsed != nil
        return HStack(spacing: 0) {
            Rectangle().fill(c).frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(lectureTitle(event.title)).font(.caption.weight(.semibold)).lineLimit(compact ? 1 : 2)
                    Spacer(minLength: 0)
                    if let elapsed {
                        Text("\(Int(elapsed * 100)) %").font(.caption2.bold().monospacedDigit())
                    }
                }
                if !compact {
                    Text("\(event.start.formatted(date: .omitted, time: .shortened)) – \(event.end.formatted(date: .omitted, time: .shortened))")
                        .font(.caption2.monospacedDigit())
                    if !event.location.isEmpty {
                        Label(event.location, systemImage: "mappin.and.ellipse").font(.caption2).lineLimit(1)
                    }
                }
            }
            .foregroundStyle(c.opacity(0.95))
            .padding(.horizontal, 6).padding(.vertical, 4)
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(c.opacity(running ? 0.28 : 0.16))
        // Vergangener Teil der laufenden Vorlesung kräftiger hinterlegt
        .background(alignment: .top) {
            if let elapsed {
                GeometryReader { g in c.opacity(0.18).frame(height: g.size.height * elapsed) }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(running ? c : .clear, lineWidth: 1.5))
    }
}

struct LectureDetail: View {
    let event: TTEvent

    var body: some View {
        let c = lectureColor(event.title)
        NavigationStack {
            List {
                Section {
                    HStack(alignment: .top, spacing: 12) {
                        RoundedRectangle(cornerRadius: 3).fill(c).frame(width: 6)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(lectureTitle(event.title)).font(.title3.bold())
                            Text(event.start.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(deLocale)))
                                .foregroundStyle(.secondary)
                            Text(event.allDay ? "ganztägig" : "\(event.start.formatted(date: .omitted, time: .shortened)) – \(event.end.formatted(date: .omitted, time: .shortened)) Uhr")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(Color.clear)
                }
                if !event.location.isEmpty {
                    Label(event.location, systemImage: "mappin.and.ellipse")
                }
                if !event.persons.isEmpty {
                    Label(event.persons.joined(separator: ", "), systemImage: "person.fill")
                }
                if !event.allDay {
                    let mins = Int(event.end.timeIntervalSince(event.start) / 60)
                    Label("\(mins / 60) h \(mins % 60) min", systemImage: "clock")
                }
                if event.elapsed() != nil {
                    TimelineView(.periodic(from: .now, by: 10)) { ctx in
                        let p = event.elapsed(at: ctx.date) ?? 1
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("\(Int(p * 100)) % vorbei").fontWeight(.semibold).foregroundStyle(c)
                                Spacer()
                                Text("noch \(Int(ceil(event.end.timeIntervalSince(ctx.date) / 60))) min").foregroundStyle(.secondary)
                            }
                            .font(.subheadline.monospacedDigit())
                            ProgressView(value: p).tint(c)
                        }
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

// Kompakte Zeile für die Startseite
struct LectureRow: View {
    let event: TTEvent

    var body: some View {
        let c = lectureColor(event.title)
        let now = !event.allDay && event.start <= Date() && event.end > Date()
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 2).fill(c).frame(width: 4, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(lectureTitle(event.title)).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text([event.allDay ? "ganztägig" : "\(event.start.formatted(date: .omitted, time: .shortened)) – \(event.end.formatted(date: .omitted, time: .shortened))",
                      event.location].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if now {
                Text("Jetzt").font(.caption2.bold()).padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.green.opacity(0.18), in: Capsule()).foregroundStyle(.green)
            }
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
                if let error { Section { Text(error).foregroundStyle(.red) } }
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

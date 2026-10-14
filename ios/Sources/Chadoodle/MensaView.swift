// Speiseplan mit Fotos, Preisen (DHBW/intern/extern), vegan/vegetarisch und Allergenen –
// und Vorbestellen über my-mensa: Warenkorb, Abholzeit (passende Pausen aus dem Stundenplan markiert), Abholschein per E-Mail.
import SwiftUI

struct MensaView: View {
    @EnvironmentObject private var mensa: MensaStore
    @State private var day: String?
    @State private var opts: OrderOptions?
    @State private var optsError: String?
    @State private var showOrder = false
    @AppStorage("mensaPriceGroup") private var group = "dhbw"

    var body: some View {
        NavigationStack {
            let plan = mensa.plan
            let days = plan?.days ?? []
            let selected = days.first { $0.date == day } ?? days.first { $0.date >= isoDay(Date()) } ?? days.first
            let canOrder = opts.map { $0.orderable && $0.date == selected?.date } ?? false
            List {
                if days.count > 1 {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(days) { d in
                                    let on = d.date == selected?.date
                                    Button { day = d.date } label: {
                                        VStack(spacing: 0) {
                                            Text(String(d.weekday.prefix(2))).font(.caption2.bold())
                                            Text(String(d.date.suffix(2))).font(.headline)
                                        }
                                        .frame(width: 44, height: 48)
                                        .background(on ? brand : Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                                        .foregroundStyle(on ? .white : .primary)
                                        .overlay(alignment: .topTrailing) {
                                            if mensa.orders.contains(where: { $0.date == d.date }) {
                                                Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(.green).offset(x: 4, y: -4)
                                            }
                                        }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.top, 4)
                        }
                        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                    }
                }
                if let d = selected {
                    let done = mensa.orders.filter { $0.date == d.date }
                    if !done.isEmpty {
                        Section("Bestellt") {
                            ForEach(done) { o in
                                VStack(alignment: .leading, spacing: 3) {
                                    Label("Nr. \(o.no)", systemImage: "checkmark.seal.fill").font(.subheadline.bold()).foregroundStyle(.green)
                                    Text(o.items.map { "\($0.n)× \($0.title)" }.joined(separator: ", ")).font(.callout)
                                    Text("Abholung \(o.time)–\(o.until) Uhr · Abholschein an \(o.email)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Section {
                        if d.dishes.isEmpty { Text("Kein Angebot an diesem Tag").foregroundStyle(.secondary) }
                        ForEach(d.dishes) { e in
                            DishRow(dish: e, group: group, order: canOrder && mensa.orderable(e, opts!) ? opts : nil, date: d.date)
                        }
                    } header: {
                        Text(d.rel.isEmpty ? d.label : "\(d.rel) · \(d.label)")
                    } footer: {
                        orderFooter(d)
                    }
                } else if !mensa.loading {
                    ContentUnavailableView("Kein Speiseplan", systemImage: "fork.knife", description: Text(plan?.error ?? "Ziehe nach unten, um ihn zu laden."))
                }
                if let plan {
                    Section {} footer: {
                        Text("Stand \(relTime(plan.fetchedAt))\(plan.error.map { " · \($0)" } ?? "")")
                    }
                }
            }
            .navigationTitle(plan?.name ?? "Mensa")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Preise", selection: $group) {
                            Text("DHBW").tag("dhbw")
                            Text("Intern").tag("intern")
                            Text("Extern").tag("extern")
                        }
                    } label: { Image(systemName: "eurosign.circle") }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let d = selected, canOrder, let o = opts {
                    let n = (mensa.cart[d.date] ?? [:]).values.reduce(0, +)
                    if n > 0 {
                        Button { showOrder = true } label: {
                            HStack {
                                Image(systemName: "bag.fill")
                                Text("Warenkorb · \(n) \(n == 1 ? "Gericht" : "Gerichte")")
                                Spacer()
                                Text(fmtEuro(total(d, o))).monospacedDigit()
                                Image(systemName: "chevron.right")
                            }
                            .font(.headline)
                            .padding(.horizontal, 18).padding(.vertical, 14)
                            .background(brand, in: RoundedRectangle(cornerRadius: 16))
                            .foregroundStyle(.white)
                        }
                        .padding(.horizontal).padding(.bottom, 6)
                    }
                }
            }
            .overlay { if mensa.loading && plan == nil { ProgressView() } }
            .refreshable {
                _ = await mensa.get(force: true)
                await loadOptions(selected?.date)
            }
            .task { _ = await mensa.get() }
            .task(id: selected?.date) { await loadOptions(selected?.date) }
            .sheet(isPresented: $showOrder) {
                if let d = selected, let o = opts {
                    OrderSheet(day: d, opts: o) { await loadOptions(d.date) }
                }
            }
        }
    }

    @ViewBuilder
    private func orderFooter(_ d: MensaDay) -> some View {
        if let e = optsError {
            Label("Bestellen gerade nicht möglich: \(e)", systemImage: "exclamationmark.triangle")
        } else if let o = opts, o.date == d.date {
            if !o.orderable {
                Label("Vorbestellung für diesen Tag geschlossen – bestellbar wieder ab \(fmtIsoDay(o.earliest)).", systemImage: "clock")
            } else {
                Label("Vorbestellbar: Gericht antippen, um es in den Warenkorb zu legen. Details und Allergene: lange drücken oder nach links wischen.", systemImage: "bag")
            }
        }
    }

    private func total(_ d: MensaDay, _ o: OrderOptions) -> Double {
        (mensa.cart[d.date] ?? [:]).reduce(0) { s, x in s + (d.dishes.first { $0.aid == x.key }?.dhbw ?? 0) * Double(x.value) }
    }

    private func loadOptions(_ date: String?) async {
        guard let date else { return }
        optsError = nil
        do {
            opts = try await mensa.orderOptions(date, email: UserDefaults.standard.string(forKey: "mensaEmail") ?? "")
        } catch {
            opts = nil
            optsError = error.localizedDescription
        }
    }
}

func fmtIsoDay(_ iso: String) -> String {
    let p = DateFormatter()
    p.dateFormat = "yyyy-MM-dd"
    guard let d = p.date(from: iso) else { return iso }
    return d.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(deLocale))
}

// Ein Tipp aufs Gericht legt es in den Warenkorb (wenn bestellbar); Details und Allergene über ⓘ
struct DishRow: View {
    @EnvironmentObject private var mensa: MensaStore
    let dish: Dish
    let group: String
    var order: OrderOptions?
    var date = ""
    @State private var showInfo = false
    @State private var bump = 0

    private var n: Int { dish.aid.flatMap { mensa.cart[date]?[$0] } ?? 0 }
    private var stock: MensaStock? { dish.aid.flatMap { order?.stock[$0] } }
    private var soldOut: Bool { stock.map { $0.rest <= 0 || $0.live <= 0 } ?? false }
    private var maxN: Int { stock.map { min(20, $0.live) } ?? 20 }
    private var canAdd: Bool { order != nil && !soldOut && n < maxN }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack(alignment: .topTrailing) {
                Group {
                    if let t = dish.thumb, let u = URL(string: t) {
                        AsyncImage(url: u) { img in img.resizable().scaledToFill() } placeholder: { Color(.secondarySystemFill) }
                    } else {
                        Image(systemName: "fork.knife").foregroundStyle(.tertiary).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(.secondarySystemFill))
                    }
                }
                .frame(width: 68, height: 68)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                if n > 0 {
                    Text("\(n)")
                        .font(.caption.bold().monospacedDigit())
                        .foregroundStyle(.white)
                        .frame(minWidth: 22, minHeight: 22)
                        .background(brand, in: Circle())
                        .offset(x: 6, y: -6)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                if !dish.category.isEmpty { Text(dish.category.uppercased()).font(.caption2.bold()).foregroundStyle(.secondary) }
                Text(dish.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                if !dish.description.isEmpty { Text(dish.description).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                HStack(spacing: 6) {
                    Text(fmtEuro(price)).font(.subheadline.monospacedDigit().bold()).foregroundStyle(brand)
                    ForEach(dish.tags.filter(\.diet).prefix(2), id: \.code) { t in DietBadge(tag: t) }
                    if order != nil {
                        if soldOut { Text("ausverkauft").font(.caption2.bold()).foregroundStyle(.red) }
                        else if let s = stock, s.live <= 15 { Text("noch \(s.live)").font(.caption2.bold()).foregroundStyle(.orange) }
                    }
                }
            }
            Spacer(minLength: 4)
            if order != nil, !(soldOut && n == 0) {
                if n > 0 {
                    VStack(spacing: 6) {
                        Button { change(+1) } label: { Image(systemName: "plus.circle.fill") }.disabled(n >= maxN)
                        Button { change(-1) } label: { Image(systemName: "minus.circle") }
                    }
                    .font(.title2)
                    .buttonStyle(.borderless)
                } else {
                    Image(systemName: "plus.circle.fill").font(.title2).foregroundStyle(brand)
                }
            } else {
                Button { showInfo = true } label: { Image(systemName: "info.circle") }
                    .font(.title3).buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture {
            if canAdd { change(+1) } else if order == nil || soldOut { showInfo = true }
        }
        .contextMenu {
            Button { showInfo = true } label: { Label("Details & Allergene", systemImage: "info.circle") }
            if n > 0 { Button(role: .destructive) { change(-n) } label: { Label("Aus dem Warenkorb", systemImage: "trash") } }
        }
        .swipeActions(edge: .trailing) {
            Button { showInfo = true } label: { Label("Details", systemImage: "info.circle") }.tint(.gray)
        }
        .sensoryFeedback(.increase, trigger: bump)
        .sheet(isPresented: $showInfo) {
            DishDetail(dish: dish, price: price).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
    }

    private func change(_ d: Int) {
        guard let aid = dish.aid else { return }
        var c = mensa.cart[date] ?? [:]
        let v = max(0, min(maxN, n + d))
        c[aid] = v > 0 ? v : nil
        withAnimation(.snappy) { mensa.cart[date] = c }
        if d > 0 { bump += 1 }
    }

    private var price: Double? {
        switch group {
        case "intern": return dish.intern
        case "extern": return dish.extern
        default: return dish.dhbw ?? dish.intern
        }
    }
}

struct DietBadge: View {
    let tag: DishTag

    var body: some View {
        let green = tag.code == "VEG" || tag.code == "V"
        Text(tag.text).font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
            .background((green ? Color.green : Color.orange).opacity(0.15), in: Capsule())
            .foregroundStyle(green ? .green : .orange)
    }
}

struct DishDetail: View {
    let dish: Dish
    let price: Double?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let t = dish.image ?? dish.thumb, let u = URL(string: t) {
                    AsyncImage(url: u) { img in img.resizable().scaledToFill() } placeholder: { Color(.secondarySystemFill) }
                        .frame(height: 200).frame(maxWidth: .infinity).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                if !dish.category.isEmpty { Text(dish.category.uppercased()).font(.caption.bold()).foregroundStyle(.secondary) }
                Text(dish.title).font(.title2.bold())
                if !dish.description.isEmpty { Text(dish.description).foregroundStyle(.secondary) }
                HStack(spacing: 6) { ForEach(dish.tags.filter(\.diet), id: \.code) { DietBadge(tag: $0) } }
                Grid(alignment: .leading, verticalSpacing: 6) {
                    GridRow { Text("DHBW").foregroundStyle(.secondary); Text(fmtEuro(dish.dhbw)).monospacedDigit() }
                    GridRow { Text("Intern").foregroundStyle(.secondary); Text(fmtEuro(dish.intern)).monospacedDigit() }
                    GridRow { Text("Extern").foregroundStyle(.secondary); Text(fmtEuro(dish.extern)).monospacedDigit() }
                }
                .font(.callout)
                let allergens = dish.tags.filter { !$0.diet }
                if !allergens.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Allergene & Zusatzstoffe").font(.headline)
                        Text(allergens.map(\.text).joined(separator: " · ")).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            .padding()
        }
    }
}

// ---------- Bestellen ----------
struct SlotButton: View {
    let slot: MensaSlot
    let on: Bool
    let good: Bool
    let action: () -> Void

    var body: some View {
        let full = slot.free <= 0
        let fill: Color = on ? brand : good ? Color.green.opacity(0.15) : Color(.secondarySystemFill)
        let text: Color = on ? .white : full ? .secondary : .primary
        Button(action: action) {
            VStack(spacing: 1) {
                Text(slot.time).font(.subheadline.bold().monospacedDigit())
                Text(full ? "voll" : "\(slot.free) frei").font(.caption2)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(fill, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(good && !on ? Color.green : Color.clear, lineWidth: 1.5))
            .foregroundStyle(text)
        }
        .buttonStyle(.plain)
        .disabled(full)
    }
}

struct OrderSheet: View {
    @EnvironmentObject private var mensa: MensaStore
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var tt: Timetables
    @Environment(\.dismiss) private var dismiss
    let day: MensaDay
    let opts: OrderOptions
    let reload: () async -> Void

    @AppStorage("mensaFirstName") private var firstName = ""
    @AppStorage("mensaLastName") private var lastName = ""
    @AppStorage("mensaEmail") private var email = ""
    @State private var agree = false
    @State private var confirm = false
    @State private var sending = false
    @State private var error: String?
    @State private var done: MensaOrder?

    private var cart: [String: Int] { mensa.cart[day.date] ?? [:] }
    private var lines: [(aid: String, n: Int, dish: Dish)] {
        cart.compactMap { aid, n in day.dishes.first { $0.aid == aid }.map { (aid, n, $0) } }.sorted { $0.dish.title < $1.dish.title }
    }
    private var total: Double { lines.reduce(0) { $0 + ($1.dish.dhbw ?? 0) * Double($1.n) } }
    private var time: String? { mensa.pickup[day.date] }

    private var missing: String? {
        if lines.isEmpty { return "Warenkorb ist leer" }
        if time == nil { return "Abholzeit wählen" }
        if firstName.trimmingCharacters(in: .whitespaces).isEmpty || lastName.trimmingCharacters(in: .whitespaces).isEmpty { return "Vor- und Nachname fehlen" }
        if email.range(of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", options: .regularExpression) == nil { return "E-Mail-Adresse fehlt" }
        if !agree { return "Nutzungsvereinbarung bestätigen" }
        return nil
    }

    // Vorlesungen des Tages aus dem aktiven Stundenplan (nil = kein Stundenplan)
    private var fits: Set<String>? {
        guard let plan = tt.active, tt.caches[plan.id] != nil else { return nil }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        guard let start = f.date(from: day.date) else { return nil }
        let events = tt.events(plan.id, from: start, to: start.addingTimeInterval(86400)).filter { Calendar.current.isDate($0.start, inSameDayAs: start) }
        return mensaSlotFits(opts.slots, date: day.date, events: events)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Warenkorb") {
                    ForEach(lines, id: \.aid) { l in
                        HStack {
                            Stepper("\(l.n)× \(l.dish.title)", value: Binding(get: { l.n }, set: { v in
                                var c = cart
                                c[l.aid] = v > 0 ? v : nil
                                mensa.cart[day.date] = c
                            }), in: 0...min(20, opts.stock[l.aid]?.live ?? 20))
                            .font(.callout)
                        }
                    }
                    LabeledContent("Summe (DHBW-Preis)", value: fmtEuro(total)).font(.callout.bold())
                }
                Section {
                    if !opts.message.isEmpty {
                        Label(opts.message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    } else if opts.slots.isEmpty {
                        Text("Für diesen Tag gibt es keine Abholzeiten.").foregroundStyle(.secondary)
                    } else {
                        let fit = fits
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 72))], spacing: 8) {
                            ForEach(opts.slots, id: \.time) { s in
                                SlotButton(slot: s, on: time == s.time, good: fit?.contains(s.time) ?? false) {
                                    mensa.pickup[day.date] = s.time
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } header: { Text("Abholzeit") } footer: {
                    if let f = fits, !f.isEmpty { Text("Grün markiert: passt in eine Pause laut deinem Stundenplan.") }
                }
                Section {
                    TextField("Vorname", text: $firstName).textContentType(.givenName)
                    TextField("Nachname", text: $lastName).textContentType(.familyName)
                    TextField("E-Mail (für den Abholschein)", text: $email).textContentType(.emailAddress)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle(isOn: $agree) {
                        if let u = URL(string: opts.termsUrl), !opts.termsUrl.isEmpty {
                            Text("Ich akzeptiere die [Nutzungsvereinbarung](\(u.absoluteString)) der Mensa.")
                        } else {
                            Text("Ich akzeptiere die Nutzungsvereinbarung der Mensa.")
                        }
                    }
                    .font(.callout)
                } header: { Text("Deine Daten") } footer: {
                    Text("Name und E-Mail bleiben auf dem iPhone und gehen nur bei einer Bestellung an my-mensa.")
                }
                if let error { Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) } }
                Section {
                    Button {
                        confirm = true
                    } label: {
                        HStack {
                            if sending { ProgressView() }
                            Text(sending ? "Wird bestellt…" : "Bestellen…").bold()
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(missing != nil || sending)
                } footer: {
                    if let missing { Text(missing) } else if let time { Text("\(lines.map(\.n).reduce(0, +)) Gerichte · Abholung \(time) Uhr am \(fmtIsoDay(day.date))") }
                }
            }
            .navigationTitle("Bestellen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } } }
            .confirmationDialog("Verbindlich bestellen?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Verbindlich bestellen · \(fmtEuro(total))") { Task { await send() } }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("\(lines.map { "\($0.n)× \($0.dish.title)" }.joined(separator: ", "))\nAbholung \(time ?? "") Uhr am \(fmtIsoDay(day.date))\nAbholschein an \(email)")
            }
            .alert("Bestellt!", isPresented: Binding(get: { done != nil }, set: { if !$0 { done = nil; dismiss() } })) {
                Button("OK") {}
            } message: {
                if let o = done { Text("Bestellnummer \(o.no)\nAbholung \(o.time)–\(o.until) Uhr. Der Abholschein kommt per E-Mail an \(o.email).") }
            }
            .onAppear {
                // Name aus dem Moodle-Konto vorschlagen
                if firstName.isEmpty { firstName = app.cache.site?.firstname ?? "" }
                if lastName.isEmpty { lastName = app.cache.site?.lastname ?? "" }
            }
        }
    }

    private func send() async {
        guard let time else { return }
        sending = true
        error = nil
        defer { sending = false }
        do {
            done = try await mensa.order(date: day.date, items: cart, time: time, firstName: firstName, lastName: lastName, email: email)
            await reload()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

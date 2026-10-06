<p align="center"><img src="build/icon.png" width="96" alt="" /></p>

<h1 align="center">Chadoodle</h1>

<p align="center">Deine Moodle-Kurse als Windows-App: lokal synchronisiert, mit PDF-Viewer, Volltextsuche und einem KI-Lernassistenten (ChatGPT oder Claude).</p>

<p align="center"><a href="https://github.com/roman-benz/campus-sync/releases/latest/download/Chadoodle-Setup.exe"><b>⬇ Installer für Windows herunterladen</b></a> · <a href="https://github.com/roman-benz/campus-sync/releases">Alle Versionen</a></p>

---

## Funktionen

- **Lokal statt Webseite:** Ein Sync-Dienst lädt im Hintergrund Kurse, Abschnitte, Aufgaben, Textseiten, Forenbeiträge, Termine, Noten und **alle Kursdateien** in einen Ordner (Standard: `Dokumente\Chadoodle\<Kurs>\<Abschnitt>\…`). Die Oberfläche liest nur diese lokale Kopie, ist dadurch schnell und funktioniert auch offline.
- **Hintergrundbetrieb:** Startet mit Windows unsichtbar im Infobereich. Synchronisiert im eingestellten Intervall, nach dem Standby und beim Öffnen. Meldet neue Dateien und bald fällige Abgaben als Windows-Benachrichtigung.
- **Dokumente in der App:** Eingebauter PDF-Viewer (pdf.js) mit Zoom, Seitensprung, markierbarem Text und Suche im Dokument. Word, PowerPoint und Excel erscheinen als Textansicht.
- **Stundenplan:** Eigener Reiter mit Wochenansicht aus Rapla oder jedem iCal-Kalender (`https://…`, `webcal://…`). Der Rapla-Plan TSA25 der DHBW Ravensburg ist als Vorlage eingetragen; eigene Links lassen sich hinzufügen. Der Plan wird lokal gespeichert und ist offline verfügbar.
- **Mensa:** Speiseplan der Mensa Fallenbrunnen (oder jeder anderen Mensa auf my-mensa.de) mit Fotos, Beschreibung, Preisen (DHBW/intern/extern), vegan/vegetarisch-Kennzeichnung und Allergenen. Der letzte Stand bleibt offline sichtbar.
- **Volltextsuche:** Alle Dokumente werden seitengenau indexiert. Die Suche in der Kopfzeile (Strg+Umschalt+F) findet Stellen in allen Skripten und springt direkt zur Seite.
- **KI-Lernassistent** (Strg+K): Durchsucht die Unterlagen, liest die passenden Seiten und erklärt sie. Fundstellen erscheinen als Links, die im Viewer an der richtigen Seite öffnen. Markierten Text im Viewer kannst du direkt „erklären“ lassen.
  - **ChatGPT:** „Continue with ChatGPT“ nutzt deinen Plus- oder Pro-Plan, ohne API-Key ([Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)).
  - **Claude:** mit eigenem Anthropic-API-Key (Standard: Claude Opus 5).
- **Design** im Stil von Moodle 4 (Navbar, Kursindex, farbcodierte Aktivitäten), moderner und mit Dark Mode.
- **Automatische Updates** aus den GitHub-Releases, still im Hintergrund.

## Installation

1. [`Chadoodle-Setup.exe`](https://github.com/roman-benz/campus-sync/releases/latest/download/Chadoodle-Setup.exe) herunterladen und starten. Es sind keine Administratorrechte nötig.
2. Windows SmartScreen warnt beim ersten Start, weil der Installer nicht signiert ist: **„Weitere Informationen“ → „Trotzdem ausführen“**.
3. Moodle-Adresse eingeben (voreingestellt: DHBW Ravensburg) und mit Kennwort oder über den Browser (SSO) anmelden.
4. Optional unter **Einstellungen → KI-Assistent** ChatGPT verbinden oder einen Claude-API-Key hinterlegen.

Voraussetzung: Die Moodle-Seite muss die Schnittstelle der offiziellen Moodle-App freigeben. Das ist bei fast allen Hochschulen der Fall.

## Datenschutz

- Gespeichert wird nur ein Zugriffstoken, kein Kennwort, verschlüsselt mit Windows DPAPI. Das gilt ebenso für API-Key und ChatGPT-Tokens.
- Kursdaten bleiben lokal. Nur Inhalte, die der KI-Assistent für eine Antwort liest, gehen an den gewählten KI-Anbieter. Namen von Forenautoren werden nie übertragen, Noten nur, wenn du das unter **Einstellungen → KI-Assistent** erlaubst.
- Kursunterlagen sind urheberrechtlich geschützt, und viele Hochschulen untersagen in ihren Moodle-Nutzungsbedingungen die Weitergabe von Inhalten an Dritte. Kläre vor Nutzung des KI-Assistenten, ob deine Hochschule das erlaubt.
- Das Zugriffstoken wird nur an die eigene Moodle-Seite gesendet. Inhalte, die auf fremde Server verweisen, werden ohne Token geladen oder blockiert.

## Entwicklung

```bash
npm install
npm start          # App starten
npm run demo       # Demo mit Beispielkursen (ohne Moodle-Zugang)
npm run dist       # Installer lokal nach out/ bauen
```

### Neue Version veröffentlichen

1. `version` in `package.json` erhöhen, z. B. `1.2.0`.
2. Committen, taggen und pushen:
   ```bash
   git commit -am "Version 1.2.0"
   git tag v1.2.0
   git push && git push --tags
   ```
3. GitHub Actions baut den Installer und veröffentlicht das Release. Installierte Apps aktualisieren sich danach automatisch.

### Aufbau

| Datei | Aufgabe |
|---|---|
| `src/main/main.js` | Fenster, Tray, IPC, Autostart, `mfile://`-Protokoll |
| `src/main/moodle.js` | Moodle-Webservice-Client, Passwort- und SSO-Login, Downloads |
| `src/main/sync.js` | Hintergrund-Sync, Dateiindex, inkrementelle Downloads, Benachrichtigungen |
| `src/main/docindex.js`, `extract.js`, `indexer-worker.js` | Seitengenauer Volltextindex in einem Hintergrundprozess |
| `src/main/ai-tools.js` | Gemeinsame KI-Werkzeuge (Dokumentsuche, Seiten lesen, Kurse, Termine, Noten) |
| `src/main/claude.js` | Claude-Chat (Streaming, Tool-Loop, Refusal-Fallback) |
| `src/main/chatgpt-auth.js`, `chatgpt.js` | Sign in with ChatGPT (OAuth + PKCE) und Chat über die Responses API |
| `src/main/updater.js` | Automatische Updates (electron-updater, GitHub-Releases) |
| `src/renderer/*` | Oberfläche (Vanilla JS ohne Build-Schritt) und PDF-Viewer (`viewer.js`) |
| `build/installer.nsh` | Autostart-Eintrag bei Installation und Deinstallation |

## Lizenz

[MIT](LICENSE) © 2026 Roman Benz. Die App hieß bis Version 1.2 „Moodle Desktop“ und in 1.3 „Campus Sync“; bestehende Installationen übernehmen Anmeldung, Einstellungen und Download-Ordner automatisch.

Chadoodle ist ein unabhängiges Projekt und nicht mit Moodle Pty Ltd verbunden oder von ihr unterstützt. Moodle™ ist eine eingetragene Marke von Moodle Pty Ltd.

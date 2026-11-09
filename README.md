# Nexo

Ein Quizsystem für GitHub Pages und Supabase. Lehrkräfte speichern und starten Quizze mit sechsstelligen Zutrittscodes; Schüler treten mit ihrem Namen bei und beantworten Multiple-Choice- oder Freitextfragen.

## Lokal starten

```sh
npm install
npm run dev
```

## Quizdateien

Im [Lehrerbereich](/lehrer) lassen sich Quizze erstellen, als JSON herunterladen und wieder hochladen. Das JSON-Format ist:

```json
{
  "title": "Mein Quiz",
  "questions": [
    {
      "prompt": "Welche Antwort ist richtig?",
      "answerType": "multiple-choice",
      "answers": ["Antwort A", "Antwort B", "Antwort C"],
      "correctAnswers": [0, 2],
      "scoringMode": "normal",
      "timeLimitSeconds": 30
    }
  ]
}
```

`answerType` kann `multiple-choice` oder `text` sein; ohne Angabe wird `multiple-choice` verwendet. Multiple-Choice-Fragen haben zwei bis sechs Optionen, und `correctAnswers` enthält die nullbasierten Indizes aller richtigen Optionen. Bei Freitextfragen enthält `answers` mindestens eine akzeptierte Antwort; die Anzahl ist nicht begrenzt. Freitext wird ohne Beachtung der Groß-/Kleinschreibung und mit ignorierten Leerzeichen am Anfang und Ende verglichen. `scoringMode` ist `normal` (bis zu 1.000 Punkte), `double` (bis zu 2.000 Punkte) oder `none`; fehlt der Wert, wird `normal` verwendet. `timeLimitSeconds` legt das Zeitlimit von 5 bis 120 Sekunden fest; fehlt der Wert, gelten 30 Sekunden. Richtige Antworten erhalten abhängig vom Tempo bis zum jeweiligen Zeitlimit zwischen 100 % und 50 % des Höchstwerts. Ältere Quizdateien mit `correctAnswer` werden beim Import weiter unterstützt.

## GitHub Pages

Die Seite wird ohne GitHub Actions direkt aus dem Ordner `docs/` im `master`-Branch veröffentlicht:

1. Prüfe, dass `.env.local` Project URL und Publishable Key für Supabase enthält.
2. Baue die fertige Website lokal mit `npm run build`. Vite erzeugt alle Dateien in `docs/`, einschließlich eines Fallbacks für Direktlinks wie `/lehrer` und `/tafel/CODE`.
3. Lade den aktualisierten Ordner `docs/` zusammen mit deinen Quellcodeänderungen in den `master`-Branch auf GitHub hoch.
4. Öffne im Repository **Settings → Pages** und wähle bei **Build and deployment → Source** die Option **Deploy from a branch**. Wähle den Branch `master` und den Ordner `/docs`, dann speichere.

GitHub Pages liefert danach den bereits lokal gebauten Inhalt direkt aus `docs/` aus. Nach jeder Änderung am Programm muss erneut `npm run build` ausgeführt und der neue Ordner `docs/` hochgeladen werden. Die GitHub-Actions-Veröffentlichung wird nicht verwendet.

## Lehrer-Anmeldung mit Supabase

Der Lehrerbereich unter `/lehrer` verwendet Supabase Auth mit E-Mail-Adresse und Passwort. Nach der Anmeldung öffnet sich ein Dashboard mit Quiz-Bibliothek, Suche, Import und Startaktionen; der Editor liegt unter `/lehrer/editor`.

1. Erstelle ein Supabase-Projekt und kopiere **Project URL** sowie den **Publishable key** aus den API-Einstellungen.
2. Deaktiviere in Supabase unter **Authentication → Providers → Email** die öffentliche Registrierung. Lege Lehrerkonten selbst über **Authentication → Users → Add user** an und setze für jedes Konto ein Passwort.
3. Für die lokale Entwicklung kopiere `.env.example` nach `.env.local` und trage dort die Project URL und den Publishable key ein. Starte die App danach neu.
4. Baue für GitHub Pages lokal mit `npm run build`. Vite liest die Werte aus `.env.local` und schreibt sie in die statische Browser-App. Der Publishable key darf öffentlich im Browser verwendet werden.
5. In Supabase unter **Authentication → URL Configuration** setze die Site URL auf die veröffentlichte GitHub-Pages-Adresse. Füge diese Adresse zusätzlich zu den Redirect URLs hinzu.
6. Öffne in Supabase **SQL Editor → New query**, kopiere den Inhalt von `supabase/schema.sql` hinein und klicke **Run**. Das richtet Quiz-, Spiel-, Spieler- und Antworttabellen samt Row-Level-Security und sicheren Spiel-Funktionen ein.

Danach kann eine Lehrkraft ein Quiz speichern oder direkt starten. Während des Spiels zeigt die App einen Zutrittscode; Schüler öffnen `/` und geben Code und Namen ein. Vor jeder Frage sehen alle fünf Sekunden lang den Antworttyp (Multiple Choice oder Freitext). Danach wird die Frage zehn Sekunden lang zum Lesen angezeigt. Anschließend erscheinen die Antworten und das einstellbare Zeitlimit von 5 bis 120 Sekunden (Standard: 30) beginnt. Die Frage wird automatisch aufgelöst, sobald alle beigetretenen Schüler geantwortet haben oder die Antwortzeit abläuft; dann werden die richtigen Antworten auf der Tafel und bei den Schülern markiert. Danach schaltet die Lehrkraft über die Steuerkonsole zur nächsten Frage weiter. Antworten werden serverseitig ausgewertet; bei Fragen mit mehreren richtigen Antworten müssen alle korrekten Optionen ausgewählt sein.

Der Publishable key ist für den Einsatz im Browser bestimmt. Verwende niemals den `service_role`-Schlüssel in der App oder in GitHub Pages. Die Datei `supabase/schema.sql` ist für ein frisches Projekt gedacht. Führe sie nicht erneut aus, wenn die Tabellen dort bereits angelegt wurden.

## Tafel und separate Steuerkonsole

Die Tafelansicht unter `/tafel/CODE` ist für den Projektor oder ein großes Display gedacht. Sie zeigt den Spielcode und vor jeder Frage fünf Sekunden lang den Antworttyp, danach zehn Sekunden lang die Frage. Anschließend zeigt sie die Antwortmöglichkeiten beziehungsweise das Freitext-Zeitlimit und die Teilnehmenden. Schüler erfahren erst, ob ihre Antwort richtig war, sobald alle geantwortet haben oder die Antwortzeit abgelaufen ist. Nach jeder Frage außer der letzten kann die Lehrkraft in der Steuerkonsole auf **Weiter · Scoreboard anzeigen** drücken. Dann erscheint das Top‑5-Scoreboard als eigene Tafelansicht und bleibt bis zum nächsten Klick auf **Nächste Frage** stehen. Nach der letzten Frage überspringt die Tafel das Top‑5-Scoreboard und zeigt beim Klick auf **Quiz beenden · Siegerpodest** direkt das Siegerpodest für die Top 3.

Die Steuerkonsole liegt unter `/lehrer/konsole/CODE`. Beim Start eines Quiz aus der Bibliothek oder dem Editor öffnet sie sich automatisch in einem neuen Tab. Alternativ lässt sich der Link auf einem zweiten Gerät öffnen; melde dich dort mit dem Lehrer-Konto an. Von dort kann die Lehrkraft das Quiz starten und Frage für Frage weiterschalten. Aus dem Dashboard oder Editor lassen sich Tafel und Steuerkonsole direkt öffnen.

Bei Multiple-Choice-Fragen mit genau einer richtigen Option können Schüler nur eine Antwort auswählen. Wenn mehrere Optionen richtig sind, können sie mehrere auswählen.

Wenn die bestehende Datenbank bereits eingerichtet ist und `supabase/multiple-choice-answers.sql` noch nicht ausgeführt wurde, führe diese Migration zuerst aus. Führe danach die aktuelle Version von `supabase/question-timer.sql` im Supabase SQL Editor vollständig aus – auch dann erneut, wenn du eine frühere Version davon bereits ausgeführt hast. Sie korrigiert auch die Antworttabellen-Regel, damit pro Schüler und Frage mehrere Antwortoptionen gespeichert werden können, und enthält den manuellen Scoreboard-Schritt, einen fünfsekündigen Vorspann mit dem Antworttyp, anschließend zehn Sekunden Lesezeit, die variable Antwortzeit, die Punktewertung und die Freitextauswertung. Bei einem frischen Projekt enthält `supabase/schema.sql` bereits den vollständigen Ablauf; zusätzliche Migrationen sind nicht nötig.

Im Editor können pro Frage normale, doppelte oder keine Punkte eingestellt werden; die zeitabhängige Wertung ist in der Punktewertungs-Migration beziehungsweise im aktuellen Schema enthalten.

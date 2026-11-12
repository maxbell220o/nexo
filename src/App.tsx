import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import {
  advanceGame,
  getDisplayGameState,
  getGameState,
  getTeacherGameState,
  joinGame,
  loadSavedQuizzes,
  saveQuiz,
  startGame,
  submitAnswer,
  submitTextAnswer,
  type PublicGameState,
  type DisplayGameState,
  type SavedQuiz,
  type TeacherGameState,
} from "./gameApi";
import { createEmptyQuestion, parseQuiz, type Quiz, type QuizQuestion } from "./types";

const starterQuiz: Quiz = {
  title: "Mein erstes Quiz",
  questions: [createEmptyQuestion()],
};

interface PopupConfig {
  markdown: string;
  buttonLabel: string | null;
}

type PopupLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; popup: PopupConfig }
  | { status: "empty" }
  | { status: "dismissed" };

function parsePopupFile(source: string): PopupConfig | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("<popup>") || !trimmed.endsWith("</popup>")) {
    throw new Error("Die Datei muss mit <popup> beginnen und mit </popup> enden.");
  }

  const content = trimmed.slice("<popup>".length, -"</popup>".length).trim();
  const buttonMatches = [...content.matchAll(/<Button<([^<>]+)>>/g)];
  if (buttonMatches.length > 1) {
    throw new Error("In popup.md ist nur ein <Button<Text>> erlaubt.");
  }

  const buttonLabel = buttonMatches[0]?.[1].trim() ?? null;
  if (buttonMatches.length && !buttonLabel) {
    throw new Error("Der Popup-Button braucht einen Text, zum Beispiel <Button<ok>>.");
  }

  const markdown = content.replace(/<Button<([^<>]+)>>/g, "").trim();
  if (!markdown) return null;

  return { markdown, buttonLabel };
}

const QUESTION_READING_SECONDS = 10;

function useQuestionTypeIntroCountdown(readingDeadline: string | null) {
  const deadlineMs = readingDeadline ? Date.parse(readingDeadline) : Number.NaN;
  const introDeadline = Number.isFinite(deadlineMs)
    ? new Date(deadlineMs - QUESTION_READING_SECONDS * 1000).toISOString()
    : null;
  return useCountdown(introDeadline);
}

function AnswerTypeIntro({
  answerType,
  secondsRemaining,
  projector = false,
}: {
  answerType: "multiple-choice" | "text";
  secondsRemaining: number;
  projector?: boolean;
}) {
  const isText = answerType === "text";
  return (
    <section className={`answer-type-intro${projector ? " answer-type-intro-projector" : ""}`}>
      <span className="answer-type-symbol" aria-hidden="true">{isText ? "Aa" : "✓"}</span>
      <span className="eyebrow">Nächster Fragetyp</span>
      <h2>{isText ? "Freitext" : "Multiple Choice"}</h2>
      <p>{isText ? "Du gibst deine Antwort selbst ein." : "Du wählst aus mehreren Antwortmöglichkeiten."}</p>
      <span className="answer-type-countdown" role="timer">
        Die Frage erscheint in {secondsRemaining} {secondsRemaining === 1 ? "Sekunde" : "Sekunden"}.
      </span>
    </section>
  );
}

function PopupOverlay({
  popup,
  onDismiss,
  error,
}: {
  popup?: PopupConfig;
  onDismiss?: () => void;
  error?: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function keepFocusInDialog(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="popup-backdrop">
      <section
        className="popup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Mitteilung"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={keepFocusInDialog}
      >
        {error ? (
          <p className="auth-error" role="alert">{error}</p>
        ) : popup ? (
          <>
            <div className="popup-markdown">
              <ReactMarkdown>{popup.markdown}</ReactMarkdown>
            </div>
            {popup.buttonLabel && onDismiss && (
              <button className="button button-primary popup-dismiss" onClick={onDismiss}>
                {popup.buttonLabel}
              </button>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          <img className="brand-mark" src={`${import.meta.env.BASE_URL}nexo-mark.svg`} alt="" />
          <span>Nexo</span>
        </Link>
        <nav aria-label="Hauptnavigation">
          <NavLink to="/" end>Mitspielen</NavLink>
          <NavLink to="/lehrer">Lehrerbereich</NavLink>
        </nav>
      </header>
      <main>{children}</main>
      <footer>Nexo · Interaktive Quizze für den Unterricht</footer>
    </div>
  );
}

function useCountdown(deadline: string | null) {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!deadline) {
      setSecondsRemaining(null);
      return;
    }
    const deadlineMs = Date.parse(deadline);
    const update = () => setSecondsRemaining(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [deadline]);

  return secondsRemaining;
}

function openConsoleTab() {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

function StudentHome() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [gameState, setGameState] = useState<PublicGameState | null>(null);
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [textAnswer, setTextAnswer] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [answering, setAnswering] = useState(false);
  const readingSecondsRemaining = useCountdown(gameState?.reading_deadline ?? null);
  const questionTypeIntroSecondsRemaining = useQuestionTypeIntroCountdown(gameState?.reading_deadline ?? null);
  const answerSecondsRemaining = useCountdown(gameState?.deadline ?? null);
  const answerPhaseStarted = Boolean(gameState?.answer_phase_started || readingSecondsRemaining === 0);
  const answerPhaseOver = Boolean(
    gameState?.answer_revealed || (answerPhaseStarted && answerSecondsRemaining === 0),
  );

  useEffect(() => {
    if (!playerId || !code) return;
    let active = true;
    const poll = async () => {
      try {
        const state = await getGameState(code, playerId);
        if (active) {
          setGameState(state);
          setError("");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Quizstatus konnte nicht geladen werden.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [code, playerId]);

  useEffect(() => {
    setSelectedAnswers([]);
    setTextAnswer("");
  }, [code, gameState?.current_question]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJoining(true);
    setError("");
    try {
      const normalizedCode = code.trim();
      const player = await joinGame(normalizedCode, name);
      setCode(normalizedCode);
      setPlayerId(player.player_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Du konntest dem Quiz nicht beitreten.");
    } finally {
      setJoining(false);
    }
  }

  function toggleAnswer(answerIndex: number) {
    setSelectedAnswers((current) => {
      if (!gameState?.question?.allow_multiple_answers) {
        return current.includes(answerIndex) ? [] : [answerIndex];
      }
      return current.includes(answerIndex)
        ? current.filter((index) => index !== answerIndex)
        : [...current, answerIndex];
    });
  }

  async function handleAnswer() {
    if (!playerId || gameState?.has_answered) return;
    if (gameState?.question?.answer_type === "text" ? !textAnswer.trim() : selectedAnswers.length === 0) {
      setError(gameState?.question?.answer_type === "text"
        ? "Gib zuerst eine Antwort ein."
        : "Wähle mindestens eine Antwort aus.");
      return;
    }
    setAnswering(true);
    setError("");
    try {
      if (gameState?.question?.answer_type === "text") {
        await submitTextAnswer(code, playerId, textAnswer.trim());
      } else {
        await submitAnswer(code, playerId, selectedAnswers);
      }
      setGameState(await getGameState(code, playerId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Antwort konnte nicht gespeichert werden.");
    } finally {
      setAnswering(false);
    }
  }

  return (
    <section className="join-page">
      <div className="hero-copy">
        <span className="eyebrow">Lernen darf Spaß machen</span>
        <h1>Bereit für<br /><span>dein Quiz?</span></h1>
        <p>Gib den Zutrittscode ein, den deine Lehrkraft mit dir geteilt hat.</p>
      </div>
      {playerId ? (
        <div className="panel join-card game-card">
          <span className="eyebrow">{gameState?.title ?? "Quiz"} · {name}</span>
          {error && <p className="auth-error" role="alert">{error}</p>}
          {!gameState ? (
            <p role="status">Quiz wird geladen ...</p>
          ) : gameState.status === "waiting" ? (
            <>
              <h2>Du bist dabei!</h2>
              <p>Warte, bis deine Lehrkraft das Quiz startet.</p>
            </>
          ) : gameState.status === "finished" ? (
            <>
              <h2>Quiz beendet!</h2>
              <p>Dein Ergebnis: <strong>{gameState.score} Punkte</strong></p>
              {gameState.leaderboard && <Leaderboard players={gameState.leaderboard} />}
            </>
          ) : (
            <>
              <p className="question-progress">Frage {gameState.current_question + 1} von {gameState.question_count}</p>
              {questionTypeIntroSecondsRemaining !== null && questionTypeIntroSecondsRemaining > 0 ? (
                <AnswerTypeIntro
                  answerType={gameState.question?.answer_type ?? "multiple-choice"}
                  secondsRemaining={questionTypeIntroSecondsRemaining}
                />
              ) : (
                <>
                  {!answerPhaseStarted ? (
                    <p className="question-timer" role="timer">
                      Lies die Frage. Antworten erscheinen in {readingSecondsRemaining ?? 10} Sekunden.
                    </p>
                  ) : !answerPhaseOver && answerSecondsRemaining !== null ? (
                    <p className="question-timer" role="timer">Noch {answerSecondsRemaining} Sekunden</p>
                  ) : null}
                  <h2>{gameState.question?.prompt}</h2>
                </>
              )}
              {gameState.answer_revealed ? (
                <p className={gameState.is_correct ? "answer-feedback correct" : "answer-feedback incorrect"} role="status">
                  {gameState.has_answered
                    ? gameState.is_correct
                      ? `Richtig! +${gameState.points_earned.toLocaleString("de-DE")} Punkte.`
                      : "Leider falsch."
                    : "Du hast keine Antwort abgegeben."}{" "}
                  · Punktestand: {gameState.score.toLocaleString("de-DE")}
                  <br />{gameState.question?.answer_type === "text" ? "Die akzeptierten Antworten werden angezeigt." : "Die richtige Antwort ist grün markiert."}
                </p>
              ) : gameState.has_answered ? (
                <p className="answer-feedback" role="status">
                  Antwort abgeschickt. Du erfährst das Ergebnis, sobald alle geantwortet haben oder die Zeit abgelaufen ist.
                </p>
              ) : answerPhaseOver ? (
                <p className="answer-feedback incorrect" role="status">
                  Du hast keine Antwort abgegeben. Das Ergebnis wird gleich aufgelöst.
                </p>
              ) : null}
              {!gameState.has_answered && answerPhaseStarted && !answerPhaseOver && (
                <div className="player-answer-list">
                  {gameState.question?.answer_type === "text" ? (
                    <>
                      <label className="visually-hidden" htmlFor="student-text-answer">Deine Antwort</label>
                      <input
                        id="student-text-answer"
                        className="student-text-answer"
                        maxLength={120}
                        value={textAnswer}
                        onChange={(event) => setTextAnswer(event.target.value)}
                        placeholder="Deine Antwort eingeben"
                        disabled={answering}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleAnswer();
                          }
                        }}
                      />
                      <button
                        className="button button-primary button-wide"
                        disabled={answering || !textAnswer.trim()}
                        onClick={() => void handleAnswer()}
                      >
                        {answering ? "Antwort wird gesendet ..." : "Antwort bestätigen"}
                      </button>
                    </>
                  ) : gameState.question?.answers.map((answer, index) => (
                    <button
                      className={`player-answer answer-${index % 4} ${selectedAnswers.includes(index) ? "player-answer-selected" : ""}`}
                      key={index}
                      disabled={answering}
                      aria-pressed={selectedAnswers.includes(index)}
                      onClick={() => toggleAnswer(index)}
                    >
                      <span className="answer-number">{index + 1}</span>{answer}
                    </button>
                  ))}
                  {gameState.question?.answer_type !== "text" && (
                    <>
                      <p className="answer-select-hint">
                        {gameState.question?.allow_multiple_answers
                          ? "Du kannst mehrere Antworten auswählen."
                          : "Wähle genau eine Antwort aus."}
                      </p>
                      <button
                        className="button button-primary button-wide"
                        disabled={answering || selectedAnswers.length === 0}
                        onClick={() => void handleAnswer()}
                      >
                        {answering ? "Antwort wird gesendet ..." : "Antwort bestätigen"}
                      </button>
                    </>
                  )}
                </div>
              )}
              {gameState.answer_revealed && gameState.question?.answer_type === "text" && gameState.question.answers.length > 0 && (
                <div className="text-answer-review">
                  <strong>Akzeptierte Antworten</strong>
                  <ul>{gameState.question.answers.map((answer, index) => <li key={index}>{answer}</li>)}</ul>
                </div>
              )}
              {gameState.answer_revealed && gameState.question?.answer_type !== "text" && (
                <div className="player-answer-list answer-review">
                  {gameState.question?.answers.map((answer, index) => (
                    <div
                      className={`player-answer answer-${index % 4} ${gameState.correct_answers?.includes(index) ? "answer-revealed-correct" : "answer-review-muted"}`}
                      key={index}
                    >
                      <span className="answer-number">{index + 1}</span>{answer}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <form className="panel join-card" onSubmit={handleSubmit}>
          <label htmlFor="join-code">Zutrittscode</label>
          <input
            id="join-code"
            className="code-input"
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            minLength={6}
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            required
          />
          <label htmlFor="player-name">Dein Name</label>
          <input
            id="player-name"
            autoComplete="nickname"
            maxLength={24}
            placeholder="Wie sollen wir dich nennen?"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-primary button-wide" type="submit" disabled={joining}>
            {joining ? "Beitritt läuft ..." : "Mitspielen"}
          </button>
          <p className="notice">Frag deine Lehrkraft nach dem sechsstelligen Zutrittscode.</p>
        </form>
      )}
    </section>
  );
}

function Leaderboard({ players }: { players: { name: string; score: number }[] }) {
  return (
    <ol className="leaderboard">
      {players.map((player, index) => (
        <li key={`${player.name}-${index}`}>
          <span>{index + 1}. {player.name}</span>
          <strong>{player.score}</strong>
        </li>
      ))}
    </ol>
  );
}

function validateQuiz(quiz: Quiz): string | null {
  if (!quiz.title.trim()) return "Bitte gib deinem Quiz einen Titel.";
  if (quiz.questions.length === 0) return "Füge mindestens eine Frage hinzu.";
  for (let index = 0; index < quiz.questions.length; index += 1) {
    const question = quiz.questions[index];
    if (!Number.isInteger(question.timeLimitSeconds) || question.timeLimitSeconds < 5 || question.timeLimitSeconds > 120) {
      return `Das Zeitlimit für Frage ${index + 1} muss zwischen 5 und 120 Sekunden liegen.`;
    }
    if (!question.prompt.trim()) return `Bitte ergänze den Text von Frage ${index + 1}.`;
    if (
      question.answers.length < (question.answerType === "text" ? 1 : 2) ||
      (question.answerType === "multiple-choice" && question.answers.length > 6)
    ) {
      return question.answerType === "text"
        ? `Frage ${index + 1} braucht mindestens eine akzeptierte Antwort.`
        : `Frage ${index + 1} braucht zwei bis sechs Antwortmöglichkeiten.`;
    }
    if (question.answers.some((answer) => !answer.trim())) {
      return `Bitte fülle alle ${question.answers.length} ${question.answerType === "text" ? "akzeptierten Antworten" : "Antworten"} bei Frage ${index + 1} aus.`;
    }
    if (question.answerType === "text") {
      if (question.answers.some((answer) => answer.length > 120)) {
        return `Akzeptierte Antworten bei Frage ${index + 1} dürfen höchstens 120 Zeichen lang sein.`;
      }
      if (new Set(question.answers.map((answer) => answer.trim().toLocaleLowerCase("de"))).size !== question.answers.length) {
        return `Frage ${index + 1} enthält doppelte akzeptierte Antworten.`;
      }
    }
    if (question.answerType === "multiple-choice" && (
      question.correctAnswers.length === 0 ||
      question.correctAnswers.some((answer) => answer < 0 || answer >= question.answers.length)
    )) {
      return `Bitte markiere mindestens eine richtige Antwort bei Frage ${index + 1}.`;
    }
  }
  return null;
}

function TeacherDashboard({
  email,
  onSignOut,
}: {
  email: string | undefined;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const [quizzes, setQuizzes] = useState<SavedQuiz[]>([]);
  const [game, setGame] = useState<TeacherGameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void loadSavedQuizzes()
      .then((saved) => { if (active) setQuizzes(saved); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Quizze konnten nicht geladen werden.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!game) return;
    let active = true;
    const poll = async () => {
      try {
        const state = await getTeacherGameState(game.code);
        if (active) {
          setGame(state);
          setError("");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Spielstatus konnte nicht geladen werden.");
      }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [game?.code]);

  async function handleStartQuiz(quiz: SavedQuiz) {
    const consoleTab = openConsoleTab();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const code = await startGame(quiz.id);
      setGame(await getTeacherGameState(code));
      if (consoleTab) {
        consoleTab.location.href = `${window.location.origin}${import.meta.env.BASE_URL}lehrer/konsole/${code}`;
      } else {
        setNotice("Quiz gestartet. Der Browser hat den neuen Tab blockiert; öffne die Steuerkonsole über den Live-Spielbereich.");
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (cause) {
      consoleTab?.close();
      setError(cause instanceof Error ? cause.message : "Das Quiz konnte nicht gestartet werden.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdvanceGame() {
    if (!game) return;
    setBusy(true);
    setError("");
    try {
      await advanceGame(game.code);
      setGame(await getTeacherGameState(game.code));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Das Quiz konnte nicht fortgesetzt werden.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyCode() {
    if (!game) return;
    try {
      await navigator.clipboard.writeText(game.code);
      setNotice("Zutrittscode wurde kopiert.");
    } catch {
      setNotice("Kopieren nicht möglich. Bitte notiere den Code.");
    }
  }

  async function handleCopyConsoleUrl() {
    if (!game) return;
    const consoleUrl = `${window.location.origin}${import.meta.env.BASE_URL}lehrer/konsole/${game.code}`;
    try {
      await navigator.clipboard.writeText(consoleUrl);
      setNotice("Link zur Steuerkonsole kopiert. Öffne ihn auf dem zweiten Gerät.");
    } catch {
      setNotice(`Steuerkonsolen-Link: ${consoleUrl}`);
    }
  }

  const visibleQuizzes = quizzes.filter((quiz) =>
    quiz.title.toLocaleLowerCase("de").includes(search.toLocaleLowerCase("de")),
  );

  return (
    <section className="dashboard-page">
      <div className="dashboard-hero">
        <div className="dashboard-hero-top">
          <span className="dashboard-greeting">Lehrerbereich</span>
          <div className="dashboard-account">
            <span>{email}</span>
            <button className="dashboard-signout" onClick={onSignOut}>Abmelden</button>
          </div>
        </div>
        <div className="dashboard-welcome">
          <div>
            <span className="dashboard-kicker">Dein Unterricht, spielerisch</span>
            <h1>Was möchtest du<br />heute quizzen?</h1>
            <p>Erstelle ein neues Quiz oder starte eines aus deiner Sammlung.</p>
          </div>
          <button
            className="button dashboard-create"
            onClick={() => navigate("/lehrer/editor")}
          >
            <span aria-hidden="true">＋</span> Neues Quiz erstellen
          </button>
        </div>
        <div className="dashboard-stats">
          <div><strong>{quizzes.length}</strong><span>Gespeicherte Quizze</span></div>
          <div><strong>{quizzes.reduce((sum, quiz) => sum + quiz.questions.length, 0)}</strong><span>Fragen insgesamt</span></div>
          <div><strong>{game ? game.players.length : "—"}</strong><span>Teilnehmende im aktuellen Spiel</span></div>
        </div>
      </div>

      {(error || notice) && (
        <p className={error ? "auth-error dashboard-message" : "form-message dashboard-message"} role={error ? "alert" : "status"}>
          {error || notice}
        </p>
      )}

      {game && (
        <section className="dashboard-section">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">Live-Spiel</span>
              <h2>Dein Quiz läuft</h2>
            </div>
            <button className="text-button" onClick={() => setGame(null)}>Ausblenden</button>
          </div>
          <div className="panel dashboard-live-card">
            <div className="live-code-block">
              <span>Zutrittscode</span>
              <strong>{game.code}</strong>
              <button className="button button-secondary" onClick={() => void handleCopyCode()}>Code kopieren</button>
              <button
                className="button button-secondary"
                onClick={() => navigate(`/lehrer/konsole/${game.code}`)}
              >
                Steuerkonsole öffnen
              </button>
              <button className="button button-secondary" onClick={() => void handleCopyConsoleUrl()}>
                Konsolen-Link kopieren
              </button>
              <button
                className="button button-secondary"
                onClick={() => window.open(`${window.location.origin}${import.meta.env.BASE_URL}tafel/${game.code}`, "_blank", "noopener,noreferrer")}
              >
                Tafel öffnen
              </button>
            </div>
            <div className="live-details">
              <div className="game-controls">
                <p>
                  {game.status === "waiting"
                    ? "Warte auf deine Klasse. Starte, wenn alle bereit sind."
                    : game.status === "finished"
                      ? "Das Quiz ist beendet."
                      : `Frage ${game.current_question + 1} von ${game.question_count}`}
                </p>
                {game.status !== "finished" && (
                  <button
                    className="button button-primary"
                    onClick={() => void handleAdvanceGame()}
                    disabled={busy || (game.status === "question" && !game.answer_revealed)}
                  >
                    {busy ? "Bitte warten ..." : game.status === "waiting" ? "Quiz starten" : game.scoreboard_revealed ? "Nächste Frage" : game.answer_revealed ? game.current_question + 1 === game.question_count ? "Quiz beenden · Siegerpodest" : "Weiter · Scoreboard anzeigen" : "Frage läuft"}
                  </button>
                )}
              </div>
              <h3>Teilnehmende <span className="count-badge">{game.players.length}</span></h3>
              {game.players.length
                ? <Leaderboard players={game.players} />
                : <p className="notice">Noch ist niemand beigetreten.</p>}
            </div>
          </div>
        </section>
      )}

      <section className="dashboard-section">
        <div className="section-title-row">
          <div>
            <span className="eyebrow">Deine Bibliothek</span>
            <h2>Meine Quizze</h2>
          </div>
          <div className="library-actions">
            <label className="search-field">
              <span className="visually-hidden">Quizze durchsuchen</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Quiz suchen ..."
              />
            </label>
            <button className="button button-secondary" onClick={() => navigate("/lehrer/editor", { state: { importQuiz: true } })}>
              Quiz importieren
            </button>
          </div>
        </div>

        {loading ? (
          <p className="empty-library" role="status">Deine Quizze werden geladen ...</p>
        ) : visibleQuizzes.length > 0 ? (
          <div className="quiz-library">
            {visibleQuizzes.map((quiz, index) => (
              <article className="panel quiz-tile" key={quiz.id}>
                <div className={`quiz-tile-art art-${index % 4}`}>
                  <span>{quiz.title.trim().charAt(0).toLocaleUpperCase("de") || "Q"}</span>
                  <span className="tile-question-count">{quiz.questions.length} {quiz.questions.length === 1 ? "Frage" : "Fragen"}</span>
                </div>
                <div className="quiz-tile-content">
                  <h3>{quiz.title}</h3>
                  <p>Multiple Choice oder Freitext</p>
                  <div className="quiz-tile-actions">
                    <button
                      className="button button-secondary"
                      onClick={() => navigate("/lehrer/editor", { state: { quiz } })}
                    >
                      Bearbeiten
                    </button>
                    <button className="button button-primary" onClick={() => void handleStartQuiz(quiz)} disabled={busy || Boolean(game && game.status !== "finished")}>
                      Quiz starten
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-library panel">
            <span className="empty-library-icon" aria-hidden="true">✦</span>
            <h3>{search ? "Kein Quiz gefunden" : "Deine Quiz-Bibliothek wartet auf dich"}</h3>
            <p>{search ? "Versuche einen anderen Suchbegriff." : "Erstelle dein erstes Quiz oder importiere eine vorhandene Quizdatei."}</p>
            {!search && (
              <button className="button button-primary" onClick={() => navigate("/lehrer/editor")}>
                Erstes Quiz erstellen
              </button>
            )}
          </div>
        )}
      </section>
    </section>
  );
}

function TeacherConsole({ code, email }: { code: string; email: string | undefined }) {
  const navigate = useNavigate();
  const [game, setGame] = useState<TeacherGameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const readingSecondsRemaining = useCountdown(game?.reading_deadline ?? null);
  const questionTypeIntroSecondsRemaining = useQuestionTypeIntroCountdown(game?.reading_deadline ?? null);
  const answerSecondsRemaining = useCountdown(game?.deadline ?? null);
  const answerPhaseStarted = Boolean(game?.answer_phase_started || readingSecondsRemaining === 0);
  const answerPhaseOver = Boolean(
    game?.answer_revealed || (answerPhaseStarted && answerSecondsRemaining === 0),
  );
  const displayUrl = `${window.location.origin}${import.meta.env.BASE_URL}tafel/${code}`;

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const state = await getTeacherGameState(code);
        if (active) {
          setGame(state);
          setError("");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Spielstatus konnte nicht geladen werden.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [code]);

  async function handleAdvance() {
    setBusy(true);
    setError("");
    try {
      await advanceGame(code);
      setGame(await getTeacherGameState(code));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Das Quiz konnte nicht fortgesetzt werden.");
    } finally {
      setBusy(false);
    }
  }

  async function copyDisplayUrl() {
    try {
      await navigator.clipboard.writeText(displayUrl);
      setNotice("Tafel-Link wurde kopiert. Öffne ihn auf dem Anzeigegerät.");
    } catch {
      setNotice(`Tafel-Link: ${displayUrl}`);
    }
  }

  return (
    <section className="console-page">
      <header className="console-header">
        <div>
          <button className="back-link" onClick={() => navigate("/lehrer")}>← Zur Übersicht</button>
          <span className="eyebrow">Steuerkonsole · {email}</span>
          <h1>Quiz-Steuerung</h1>
          <p>Diese Seite ist für dein Steuergerät. Die Tafel kann auf einem anderen Bildschirm geöffnet sein.</p>
        </div>
        <Link className="button button-secondary" to={`/tafel/${code}`} target="_blank" rel="noreferrer">
          Tafel in neuem Tab öffnen
        </Link>
      </header>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="form-message" role="status">{notice}</p>}
      {loading ? (
        <p className="auth-loading" role="status">Quiz wird geladen ...</p>
      ) : game ? (
        <>
          <section className="panel console-code-card">
            <div>
              <span className="eyebrow">Zutrittscode für die Klasse</span>
              <strong>{game.code}</strong>
              <p>Die Schüler treten auf der Startseite mit diesem Code und ihrem Namen bei.</p>
            </div>
            <div className="console-link-actions">
              <button className="button button-secondary" onClick={() => void copyDisplayUrl()}>
                Tafel-Link kopieren
              </button>
              <button
                className="button button-primary console-advance"
                onClick={() => void handleAdvance()}
                disabled={busy || game.status === "finished" || (game.status === "question" && !answerPhaseOver)}
              >
                {busy ? "Bitte warten ..." : game.status === "waiting" ? "Quiz starten" : game.status === "finished" ? "Quiz beendet" : !answerPhaseOver ? "Frage läuft" : game.scoreboard_revealed ? "Nächste Frage" : game.current_question + 1 === game.question_count ? "Quiz beenden · Siegerpodest" : "Weiter · Scoreboard anzeigen"}
              </button>
            </div>
          </section>
          <div className="console-grid">
            <section className="panel console-status-card">
              <span className="eyebrow">Spielstatus</span>
              <h2>
                {game.status === "waiting"
                  ? "Warte auf die Klasse"
                  : game.status === "finished"
                    ? "Quiz abgeschlossen"
                    : `Frage ${game.current_question + 1} von ${game.question_count}`}
              </h2>
              <p>
                {game.status === "waiting"
                  ? "Wenn alle Schüler auf der Tafel erscheinen, kannst du das Quiz starten."
                  : game.status === "finished"
                    ? "Das Ergebnis wird auf der Tafel angezeigt."
                    : answerPhaseOver
                      ? game.scoreboard_revealed
                        ? "Das Scoreboard wird auf der Tafel angezeigt. Mit „Nächste Frage“ geht es weiter."
                        : "Alle Antworten sind da. Drücke „Weiter“, um das Scoreboard auf der Tafel anzuzeigen."
                      : !answerPhaseStarted
                        ? questionTypeIntroSecondsRemaining !== null && questionTypeIntroSecondsRemaining > 0
                          ? `Antworttyp wird angezeigt: noch ${questionTypeIntroSecondsRemaining} Sekunden.`
                          : `Lesezeit: noch ${readingSecondsRemaining ?? 10} Sekunden.`
                        : `Antworten eingegangen: ${game.answered_count} von ${game.players.length}. Noch ${answerSecondsRemaining ?? 30} Sekunden.`}
              </p>
            </section>
            <section className="panel console-players-card">
              <h2>Teilnehmende <span className="count-badge">{game.players.length}</span></h2>
              {game.players.length
                ? <Leaderboard players={game.players} />
                : <p className="notice">Noch ist niemand beigetreten.</p>}
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ProjectorDisplay() {
  const { code = "" } = useParams();
  const [game, setGame] = useState<DisplayGameState | null>(null);
  const [error, setError] = useState("");
  const readingSecondsRemaining = useCountdown(game?.reading_deadline ?? null);
  const questionTypeIntroSecondsRemaining = useQuestionTypeIntroCountdown(game?.reading_deadline ?? null);
  const answerSecondsRemaining = useCountdown(game?.deadline ?? null);
  const answerPhaseStarted = Boolean(game?.answer_phase_started || readingSecondsRemaining === 0);
  const answerPhaseOver = Boolean(
    game?.answer_revealed || (answerPhaseStarted && answerSecondsRemaining === 0),
  );

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const state = await getDisplayGameState(code);
        if (active) {
          setGame(state);
          setError("");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Tafelansicht konnte nicht geladen werden.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [code]);

  return (
    <section className="projector-screen">
      <header className="projector-header">
        <Link className="projector-brand" to="/">
          <img className="brand-mark" src={`${import.meta.env.BASE_URL}nexo-mark.svg`} alt="" />
          <span>Nexo</span>
        </Link>
        <div className="projector-room-code"><span>SPIELCODE</span><strong>{code}</strong></div>
        <span className="projector-live"><i /> LIVE</span>
      </header>
      {error ? (
        <div className="projector-message">
          <h1>Quiz nicht gefunden</h1>
          <p>{error}</p>
          <Link className="button button-secondary" to="/">Zur Startseite</Link>
        </div>
      ) : !game ? (
        <div className="projector-message" role="status">
          <span className="projector-spinner" />
          <h1>Verbinde mit dem Quiz ...</h1>
        </div>
      ) : game.status === "waiting" ? (
        <div className="projector-lobby">
          <div className="projector-lobby-main">
            <span className="projector-kicker">Macht euch bereit!</span>
            <h1>{game.title}</h1>
            <p>Gehe auf die Quiz-Seite und gib diesen Code ein:</p>
            <strong className="projector-big-code">{game.code}</strong>
            <div className="projector-join-url">{window.location.origin}{import.meta.env.BASE_URL}</div>
          </div>
          <aside className="projector-participants panel">
            <h2>Teilnehmende <span>{game.players.length}</span></h2>
            {game.players.length ? (
              <ul>{game.players.map((player, index) => <li key={`${player.name}-${index}`}><span>{player.name}</span><i>✓</i></li>)}</ul>
            ) : <p>Die Klasse wartet auf den Start ...</p>}
          </aside>
        </div>
      ) : game.status === "finished" ? (
        <div className="projector-finished">
          <span className="projector-kicker">Das war's!</span>
          <h1>Siegerpodest</h1>
          <p>Die drei Besten im Quiz „{game.title}“</p>
          {game.players.length ? (
            <div className="projector-podium-stage">
              {[1, 0, 2].map((playerIndex) => {
                const player = game.players[playerIndex];
                if (!player) return <div className="podium-place-empty" key={`empty-${playerIndex}`} />;
                const rank = playerIndex + 1;
                return (
                  <article className={`podium-place podium-place-${rank}`} key={`${player.name}-${rank}`}>
                    <span className="podium-medal">{rank === 1 ? "1." : rank === 2 ? "2." : "3."} Platz</span>
                    <strong className="podium-player-name">{player.name}</strong>
                    <span className="podium-player-score">{player.score.toLocaleString("de-DE")} Punkte</span>
                    <span className="podium-block">{rank}</span>
                  </article>
                );
              })}
            </div>
          ) : (
            <p>Es sind keine Spieler im Quiz.</p>
          )}
        </div>
      ) : game.scoreboard_revealed ? (
        <div className="projector-scoreboard-page">
          <span className="projector-kicker">Frage {game.current_question + 1} aufgelöst</span>
          <h1>Top 5 · Scoreboard</h1>
          <p>Die Rangliste nach dieser Frage</p>
          {game.players.length ? (
            <ol className="projector-scoreboard-list">
              {game.players.slice(0, 5).map((player, index) => (
                <li key={`${player.name}-${index}`} className={index < 3 ? `scoreboard-place-${index + 1}` : ""}>
                  <span className="scoreboard-rank">{index + 1}</span>
                  <span className="scoreboard-name">{player.name}</span>
                  <strong>{player.score.toLocaleString("de-DE")} Punkte</strong>
                </li>
              ))}
            </ol>
          ) : (
            <p>Es sind noch keine Spieler beigetreten.</p>
          )}
          {game.question?.answer_type === "text" && game.question.answers.length > 0 && (
            <div className="text-answer-review">
              <strong>Akzeptierte Antworten</strong>
              <ul>{game.question.answers.map((answer, index) => <li key={index}>{answer}</li>)}</ul>
            </div>
          )}
          <span className="scoreboard-next-hint">Die Lehrkraft startet die nächste Frage.</span>
        </div>
      ) : questionTypeIntroSecondsRemaining !== null && questionTypeIntroSecondsRemaining > 0 ? (
        <AnswerTypeIntro
          answerType={game.question?.answer_type ?? "multiple-choice"}
          secondsRemaining={questionTypeIntroSecondsRemaining}
          projector
        />
      ) : (
        <div className="projector-question-layout">
          <section className="projector-question">
            <div className="projector-question-meta">
              <span>{game.title}</span>
              <strong>FRAGE {game.current_question + 1} <i>/</i> {game.question_count}</strong>
            </div>
            <div className="projector-question-content">
              <span className="projector-kicker">
                {game.answer_revealed
                  ? "Richtige Antwort"
                  : answerPhaseOver
                    ? "Zeit abgelaufen – Antworten werden aufgelöst"
                    : !answerPhaseStarted
                      ? `Lies die Frage · Antworten erscheinen in ${readingSecondsRemaining ?? 10} Sekunden`
                      : `Noch ${answerSecondsRemaining ?? 30} Sekunden · ${game.answered_count} von ${game.players.length} Antworten`}
              </span>
              <h1>{game.question?.prompt}</h1>
              {answerPhaseStarted && <div className="projector-answers">
                {game.question?.answers.map((answer, index) => (
                  <div className={`projector-answer projector-answer-${index % 4} ${game.answer_revealed && game.correct_answers?.includes(index) ? "projector-answer-correct" : game.answer_revealed ? "projector-answer-muted" : ""}`} key={index}>
                      <span className="projector-answer-shape">{["▲", "◆", "●", "■", "★", "⬟"][index]}</span>
                    <span>{answer}</span>
                    {game.answer_revealed && game.correct_answers?.includes(index) && <strong className="projector-correct-label">RICHTIG</strong>}
                  </div>
                ))}
              </div>}
            </div>
            <div className="projector-progress"><span style={{ width: `${((game.current_question + 1) / game.question_count) * 100}%` }} /></div>
          </section>
          <aside className="projector-question-players">
            <div className="projector-answer-count">{game.answered_count}<span>von {game.players.length} Antworten</span></div>
            <h2>Spieler</h2>
            <ul>{game.players.slice(0, 12).map((player, index) => <li key={`${player.name}-${index}`}>{player.name}</li>)}</ul>
            {game.players.length > 12 && <span className="projector-more">und {game.players.length - 12} weitere ...</span>}
          </aside>
        </div>
      )}
    </section>
  );
}

function TeacherGamePanel({
  game,
  onAdvance,
  busy,
}: {
  game: TeacherGameState;
  onAdvance: () => void;
  busy: boolean;
}) {
  const [copyMessage, setCopyMessage] = useState("");
  const readingSecondsRemaining = useCountdown(game.reading_deadline);
  const questionTypeIntroSecondsRemaining = useQuestionTypeIntroCountdown(game.reading_deadline);
  const answerSecondsRemaining = useCountdown(game.deadline);
  const answerPhaseStarted = game.answer_phase_started || readingSecondsRemaining === 0;
  const answerPhaseOver = game.answer_revealed || (answerPhaseStarted && answerSecondsRemaining === 0);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(game.code);
      setCopyMessage("Code kopiert.");
    } catch {
      setCopyMessage("Kopieren nicht möglich. Bitte notiere den Code.");
    }
  }

  return (
    <section className="panel active-game">
      <div className="game-code">
        <div>
          <span className="eyebrow">Zutrittscode für Schüler</span>
          <strong>{game.code}</strong>
          <p>Schüler öffnen die Startseite und geben diesen Code sowie ihren Namen ein.</p>
        </div>
        <button
          className="button button-secondary"
          onClick={() => void copyCode()}
        >
          Code kopieren
        </button>
      </div>
      <div className="game-screen-links">
        <Link className="button button-secondary" to={`/lehrer/konsole/${game.code}`} target="_blank" rel="noreferrer">
          Steuerkonsole auf anderem Gerät
        </Link>
        <Link className="button button-secondary" to={`/tafel/${game.code}`} target="_blank" rel="noreferrer">
          Tafel öffnen
        </Link>
      </div>
      {copyMessage && <p className="form-message" role="status">{copyMessage}</p>}
      <div className="game-controls">
        <p>
          {game.status === "waiting"
            ? "Warte auf Schüler. Starte das Quiz, wenn alle bereit sind."
            : game.status === "finished"
              ? "Das Quiz ist beendet."
              : answerPhaseOver
                ? game.scoreboard_revealed
                  ? "Scoreboard wird auf der Tafel angezeigt."
                  : `Antworten abgeschlossen · ${game.answered_count} von ${game.players.length}. Mit „Weiter“ erscheint das Scoreboard.`
                : !answerPhaseStarted
                  ? questionTypeIntroSecondsRemaining !== null && questionTypeIntroSecondsRemaining > 0
                    ? `Frage ${game.current_question + 1} von ${game.question_count} · Antworttyp: ${questionTypeIntroSecondsRemaining} Sekunden`
                    : `Frage ${game.current_question + 1} von ${game.question_count} · Lesezeit: ${readingSecondsRemaining ?? 10} Sekunden`
                  : `Frage ${game.current_question + 1} von ${game.question_count} · ${game.answered_count} von ${game.players.length} Antworten · noch ${answerSecondsRemaining ?? 30} Sekunden`}
        </p>
        {game.status !== "finished" && (
          <button className="button button-primary" onClick={onAdvance} disabled={busy || (game.status === "question" && !answerPhaseOver)}>
            {busy ? "Bitte warten ..." : game.status === "waiting" ? "Quiz starten" : !answerPhaseOver ? "Frage läuft" : game.scoreboard_revealed ? "Nächste Frage" : game.current_question + 1 === game.question_count ? "Quiz beenden · Siegerpodest" : "Weiter · Scoreboard anzeigen"}
          </button>
        )}
      </div>
      <h3>Teilnehmende <span className="count-badge">{game.players.length}</span></h3>
      {game.players.length === 0
        ? <p className="notice">Noch ist niemand beigetreten.</p>
        : <Leaderboard players={game.players} />}
    </section>
  );
}

function TeacherEditor({
  authError,
  ownerId,
}: {
  authError: string;
  ownerId: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const editorState = location.state as { quiz?: SavedQuiz; importQuiz?: boolean } | null;
  const initialQuiz = editorState?.quiz;
  const editingSavedQuiz = Boolean(initialQuiz);
  const [quiz, setQuiz] = useState<Quiz>(initialQuiz ?? starterQuiz);
  const [quizId, setQuizId] = useState(initialQuiz?.id ?? null);
  const [message, setMessage] = useState("");
  const [activeGame, setActiveGame] = useState<TeacherGameState | null>(null);
  const [saving, setSaving] = useState(false);
  const [gameError, setGameError] = useState("");
  const [expandedQuestion, setExpandedQuestion] = useState<number | null>(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editorState?.importQuiz) fileInput.current?.click();
  }, [editorState?.importQuiz]);

  useEffect(() => {
    if (!activeGame) return;
    let active = true;
    const poll = async () => {
      try {
        const state = await getTeacherGameState(activeGame.code);
        if (active) {
          setActiveGame(state);
          setGameError("");
        }
      } catch (cause) {
        if (active) setGameError(cause instanceof Error ? cause.message : "Spielstatus konnte nicht geladen werden.");
      }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeGame?.code]);

  async function handleSaveQuiz() {
    const validationError = validateQuiz(quiz);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const saved = await saveQuiz(quiz, ownerId, quizId ?? undefined);
      setQuizId(saved.id);
      setMessage("Quiz wurde in Supabase gespeichert.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Quiz konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  }

  async function handleStartGame() {
    const validationError = validateQuiz(quiz);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    const consoleTab = openConsoleTab();
    setSaving(true);
    setMessage("");
    setGameError("");
    try {
      const saved = await saveQuiz(quiz, ownerId, quizId ?? undefined);
      setQuizId(saved.id);
      const code = await startGame(saved.id);
      setActiveGame(await getTeacherGameState(code));
      if (consoleTab) {
        consoleTab.location.href = `${window.location.origin}${import.meta.env.BASE_URL}lehrer/konsole/${code}`;
      } else {
        setMessage("Quiz gestartet. Öffne die Steuerkonsole über den Link beim Spielcode.");
      }
    } catch (cause) {
      consoleTab?.close();
      setGameError(cause instanceof Error ? cause.message : "Das Quiz konnte nicht gestartet werden.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAdvanceGame() {
    if (!activeGame) return;
    setSaving(true);
    setGameError("");
    try {
      await advanceGame(activeGame.code);
      setActiveGame(await getTeacherGameState(activeGame.code));
    } catch (cause) {
      setGameError(cause instanceof Error ? cause.message : "Das Quiz konnte nicht fortgesetzt werden.");
    } finally {
      setSaving(false);
    }
  }

  function updateQuestion(index: number, update: Partial<QuizQuestion>) {
    setQuiz((current) => ({
      ...current,
      questions: current.questions.map((question, questionIndex) =>
        questionIndex === index ? { ...question, ...update } : question,
      ),
    }));
    setMessage("");
  }

  function updateAnswer(questionIndex: number, answerIndex: number, value: string) {
    const question = quiz.questions[questionIndex];
    const answers = [...question.answers];
    answers[answerIndex] = value;
    updateQuestion(questionIndex, { answers });
  }

  function addAnswer(questionIndex: number) {
    const question = quiz.questions[questionIndex];
    if (question.answerType === "multiple-choice" && question.answers.length >= 6) return;
    const answers = [...question.answers, ""];
    updateQuestion(questionIndex, {
      answers,
      correctAnswers: question.answerType === "text" ? answers.map((_, index) => index) : question.correctAnswers,
    });
  }

  function changeAnswerType(questionIndex: number, answerType: QuizQuestion["answerType"]) {
    const question = quiz.questions[questionIndex];
    if (answerType === "text") {
      updateQuestion(questionIndex, {
        answerType,
        correctAnswers: question.answers.map((_, index) => index),
      });
      return;
    }
    const answers = question.answers.slice(0, 6);
    while (answers.length < 2) answers.push("");
    updateQuestion(questionIndex, { answerType, answers, correctAnswers: [0] });
  }

  function addQuestion() {
    setExpandedQuestion(quiz.questions.length);
    setQuiz((current) => ({
      ...current,
      questions: [...current.questions, createEmptyQuestion()],
    }));
    setMessage("");
  }

  function removeQuestion(questionIndex: number) {
    const questions = quiz.questions.filter((_, index) => index !== questionIndex);
    setExpandedQuestion((expanded) => {
      if (expanded === null || expanded === questionIndex) {
        return questions.length ? Math.min(questionIndex, questions.length - 1) : null;
      }
      return expanded > questionIndex ? expanded - 1 : expanded;
    });
    setQuiz((current) => ({ ...current, questions }));
    setMessage("");
  }

  function removeAnswer(questionIndex: number, answerIndex: number) {
    const question = quiz.questions[questionIndex];
    if (question.answers.length <= (question.answerType === "text" ? 1 : 2)) return;
    const answers = question.answers.filter((_, index) => index !== answerIndex);
    const remainingCorrectAnswers = question.correctAnswers
      .filter((index) => index !== answerIndex)
      .map((index) => index > answerIndex ? index - 1 : index);
    const correctAnswers = question.answerType === "text"
      ? answers.map((_, index) => index)
      : remainingCorrectAnswers.length ? remainingCorrectAnswers : [0];
    updateQuestion(questionIndex, { answers, correctAnswers });
  }

  function exportQuiz() {
    const error = validateQuiz(quiz);
    if (error) {
      setMessage(error);
      return;
    }
    const file = new Blob([JSON.stringify(quiz, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${quiz.title.trim().replace(/[^\p{L}\p{N}-]+/gu, "-") || "quiz"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("Quizdatei wurde heruntergeladen.");
  }

  async function importQuiz(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = parseQuiz(JSON.parse(await file.text()));
      setQuiz(imported);
      setQuizId(null);
      setExpandedQuestion(0);
      setMessage("Quiz wurde erfolgreich geladen.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Die Quizdatei konnte nicht gelesen werden.");
    } finally {
      event.target.value = "";
    }
  }

  return (
    <section className="editor-page">
      <div className="page-heading">
        <div>
          <button className="back-link" onClick={() => navigate("/lehrer")}>← Zur Übersicht</button>
          <span className="eyebrow">Quiz-Editor</span>
          <h1>{editingSavedQuiz ? "Quiz bearbeiten" : "Quiz erstellen"}</h1>
          <p>{quiz.title || "Unbenanntes Quiz"} · {quiz.questions.length} Fragen</p>
        </div>
        <div className="toolbar">
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            onChange={importQuiz}
            aria-label="Quizdatei hochladen"
          />
          <button className="button button-secondary" onClick={() => fileInput.current?.click()}>
            Quiz importieren
          </button>
          <button className="button button-secondary" onClick={exportQuiz}>
            JSON exportieren
          </button>
        </div>
      </div>

      {authError && <p className="auth-error" role="alert">{authError}</p>}
      {activeGame && (
        <TeacherGamePanel game={activeGame} onAdvance={() => void handleAdvanceGame()} busy={saving} />
      )}
      {gameError && <p className="auth-error" role="alert">{gameError}</p>}

      <section className="editor-setup panel">
        <span className="editor-step">1</span>
        <div className="editor-setup-content">
          <label className="field-label" htmlFor="quiz-title">Quiz-Titel</label>
          <input
            id="quiz-title"
            className="title-input"
            maxLength={100}
            value={quiz.title}
            onChange={(event) => {
              setQuiz((current) => ({ ...current, title: event.target.value }));
              setMessage("");
            }}
            placeholder="Zum Beispiel: Planeten unseres Sonnensystems"
          />
          <span className="field-hint">Gib deinem Quiz einen kurzen, leicht wiederzufindenden Namen.</span>
        </div>
      </section>

      <div className="questions-heading">
        <div>
          <span className="eyebrow">Schritt 2</span>
          <h2>Deine Fragen <span className="count-badge">{quiz.questions.length}</span></h2>
          <p>Multiple Choice: 2 bis 6 Optionen. Freitext: beliebig viele akzeptierte Antworten.</p>
        </div>
        <button
          className="button button-secondary"
          onClick={addQuestion}
        >
          <span aria-hidden="true">＋</span> Frage hinzufügen
        </button>
      </div>

      <div className="question-list">
        {quiz.questions.map((question, questionIndex) => (
          <article className={`panel question-card ${expandedQuestion === questionIndex ? "question-card-open" : ""}`} key={questionIndex}>
            <div className="question-card-heading">
              <button
                className="question-card-toggle"
                type="button"
                aria-expanded={expandedQuestion === questionIndex}
                onClick={() => setExpandedQuestion((current) => current === questionIndex ? null : questionIndex)}
              >
                <span className="question-number">{String(questionIndex + 1).padStart(2, "0")}</span>
                <span className="question-card-title">
                  <strong>Frage {questionIndex + 1}</strong>
                  <span className="question-summary">
                    {question.prompt.trim() || "Fragetext eingeben"}
                  </span>
                </span>
                <span className="question-card-meta">
                  {question.answerType === "text"
                    ? `${question.answers.length} akzeptierte Antworten`
                    : <>{question.answers.length} Antworten<span className="question-correct-count"> · {question.correctAnswers.length} richtig</span></>}
                  <span>· {question.timeLimitSeconds} Sek.</span>
                  <span>· {question.scoringMode === "double" ? "2× Punkte" : question.scoringMode === "none" ? "0 Punkte" : "1× Punkte"}</span>
                  <span className="question-chevron" aria-hidden="true">⌄</span>
                </span>
              </button>
              {quiz.questions.length > 1 && (
                <button
                  className="text-button danger-text remove-question"
                  type="button"
                  onClick={() => removeQuestion(questionIndex)}
                  aria-label={`Frage ${questionIndex + 1} entfernen`}
                >
                  Löschen
                </button>
              )}
            </div>
            {expandedQuestion === questionIndex && (
              <div className="question-card-body">
                <label className="field-label" htmlFor={`prompt-${questionIndex}`}>Fragetext</label>
                <textarea
                  id={`prompt-${questionIndex}`}
                  maxLength={300}
                  rows={2}
                  value={question.prompt}
                  onChange={(event) => updateQuestion(questionIndex, { prompt: event.target.value })}
                  placeholder="Zum Beispiel: Welcher Planet ist der größte?"
                />
                <div className="scoring-mode">
                  <label className="field-label" htmlFor={`answer-type-${questionIndex}`}>Antworttyp</label>
                  <select
                    id={`answer-type-${questionIndex}`}
                    value={question.answerType}
                    onChange={(event) => changeAnswerType(questionIndex, event.target.value as QuizQuestion["answerType"])}
                  >
                    <option value="multiple-choice">Multiple Choice</option>
                    <option value="text">Texteingabe (Freitext)</option>
                  </select>
                  <span className="field-hint">
                    {question.answerType === "text"
                      ? "Schüler geben eine Antwort ein. Lege alle Schreibweisen oder Alternativen an, die als richtig gelten."
                      : "Schüler wählen eine oder mehrere der Antwortmöglichkeiten aus."}
                  </span>
                </div>
                <div className="scoring-mode">
                  <label className="field-label" htmlFor={`time-limit-${questionIndex}`}>Zeitlimit</label>
                  <div className="time-limit-input">
                    <input
                      id={`time-limit-${questionIndex}`}
                      type="number"
                      min={5}
                      max={120}
                      step={1}
                      value={question.timeLimitSeconds}
                      onChange={(event) => updateQuestion(questionIndex, {
                        timeLimitSeconds: event.target.value === "" ? 0 : Number(event.target.value),
                      })}
                    />
                    <span>Sekunden</span>
                  </div>
                  <span className="field-hint">Zwischen 5 und 120 Sekunden. Die Zeit läuft ab Freigabe der Frage.</span>
                </div>
                <div className="scoring-mode">
                  <label className="field-label" htmlFor={`scoring-${questionIndex}`}>Punktewertung</label>
                  <select
                    id={`scoring-${questionIndex}`}
                    value={question.scoringMode}
                    onChange={(event) => updateQuestion(questionIndex, {
                      scoringMode: event.target.value as QuizQuestion["scoringMode"],
                    })}
                  >
                    <option value="normal">Normale Punkte (bis zu 1.000)</option>
                    <option value="double">Doppelte Punkte (bis zu 2.000)</option>
                    <option value="none">Keine Punkte</option>
                  </select>
                  <span className="field-hint">Für richtige Antworten gibt es je nach Antworttempo mehr Punkte. Der Tempo-Bonus sinkt über die eingestellte Zeit bis zur Hälfte.</span>
                </div>
                <fieldset className="answers-fieldset">
                  <legend>
                    {question.answerType === "text" ? "Akzeptierte Antworten" : "Antwortmöglichkeiten"}
                    <span>{question.answerType === "text" ? "Jede dieser Eingaben gilt als richtig." : "Markiere alle richtigen Antworten."}</span>
                  </legend>
                  <div className="answer-grid">
                    {question.answers.map((answer, answerIndex) => (
                      <div className={`answer-option answer-${answerIndex % 6} ${question.correctAnswers.includes(answerIndex) ? "is-correct" : ""}`} key={answerIndex}>
                        <span className="answer-number">{answerIndex + 1}</span>
                        <input
                          className="answer-input"
                          maxLength={120}
                          value={answer}
                          onChange={(event) => updateAnswer(questionIndex, answerIndex, event.target.value)}
                          placeholder={`Antwort ${answerIndex + 1}`}
                          aria-label={`Antwort ${answerIndex + 1} für Frage ${questionIndex + 1}`}
                        />
                        {question.answerType === "multiple-choice" && (
                          <label className="correct-answer-toggle">
                            <input
                              type="checkbox"
                              checked={question.correctAnswers.includes(answerIndex)}
                              onChange={(event) => {
                                const correctAnswers = event.target.checked
                                  ? [...question.correctAnswers, answerIndex]
                                  : question.correctAnswers.filter((index) => index !== answerIndex);
                                updateQuestion(questionIndex, { correctAnswers });
                              }}
                            />
                            <span>Richtig</span>
                          </label>
                        )}
                        {question.answers.length > (question.answerType === "text" ? 1 : 2) && (
                          <button
                            className="remove-answer"
                            type="button"
                            onClick={() => removeAnswer(questionIndex, answerIndex)}
                            aria-label={`Antwort ${answerIndex + 1} entfernen`}
                            title="Antwort entfernen"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="answer-actions">
                    <button
                      className="add-answer-button"
                      type="button"
                      onClick={() => addAnswer(questionIndex)}
                      disabled={question.answerType === "multiple-choice" && question.answers.length >= 6}
                    >
                      ＋ {question.answerType === "text" ? "Antwortvariante hinzufügen" : "Antwort hinzufügen"}
                    </button>
                    <span>
                      {question.answerType === "text"
                        ? `${question.answers.length} akzeptierte Antworten · kein Limit`
                        : `${question.answers.length} von 6 Antworten · mindestens 2`}
                    </span>
                  </div>
                </fieldset>
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="editor-bottom">
        <button className="button button-secondary" onClick={addQuestion}>
          ＋ Frage hinzufügen
        </button>
      </div>
      {(message || gameError) && <p className={gameError ? "auth-error" : "form-message"} role={gameError ? "alert" : "status"}>{gameError || message}</p>}
      <div className="editor-action-bar">
        <div>
          <strong>{quiz.title || "Unbenanntes Quiz"}</strong>
          <span>{quiz.questions.length} {quiz.questions.length === 1 ? "Frage" : "Fragen"}</span>
        </div>
        <div>
          <button className="button button-secondary" onClick={() => void handleSaveQuiz()} disabled={saving}>
            {saving ? "Speichert ..." : "Speichern"}
          </button>
          <button className="button button-primary" onClick={() => void handleStartGame()} disabled={saving}>
            {saving ? "Bitte warten ..." : "Quiz starten"}
          </button>
        </div>
      </div>
    </section>
  );
}

function TeacherLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setError("Supabase ist noch nicht konfiguriert. Bitte trage URL und Publishable Key ein.");
      return;
    }

    setError("");
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (signInError) setError(signInError.message);
  }

  return (
    <section className="login-page">
      <div>
        <span className="eyebrow">Lehrerbereich</span>
        <h1>Willkommen zurück</h1>
        <p>Melde dich mit deinem Lehrer-Konto an, um Quizze zu erstellen.</p>
      </div>
      <form className="panel login-card" onSubmit={handleSubmit}>
        <label htmlFor="teacher-email">E-Mail-Adresse</label>
        <input
          id="teacher-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@schule.de"
        />
        <label htmlFor="teacher-password">Passwort</label>
        <input
          id="teacher-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Dein Passwort"
        />
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="button button-primary button-wide" type="submit" disabled={submitting}>
          {submitting ? "Anmeldung läuft ..." : "Anmelden"}
        </button>
        <p className="notice">Lehrerkonten werden sicher in Supabase verwaltet.</p>
      </form>
    </section>
  );
}

function TeacherPage() {
  const location = useLocation();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
      setAuthError("");
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        setAuthError(error.message);
      } else {
        setSession(data.session);
      }
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) setAuthError(error.message);
  }

  if (loading) {
    return <p className="auth-loading" role="status">Anmeldestatus wird geladen ...</p>;
  }

  if (!session) {
    return (
      <>
        {authError && <p className="auth-error page-auth-error" role="alert">{authError}</p>}
        <TeacherLogin />
      </>
    );
  }

  if (location.pathname.replace(/\/+$/, "").endsWith("/editor")) {
    return (
      <TeacherEditor
        authError={authError}
        ownerId={session.user.id}
      />
    );
  }

  const consoleMatch = location.pathname.match(/\/lehrer\/konsole\/(\d{6})\/?$/);
  if (consoleMatch) {
    return <TeacherConsole code={consoleMatch[1]} email={session.user.email} />;
  }

  return <TeacherDashboard email={session.user.email} onSignOut={signOut} />;
}

function NotFound() {
  return (
    <section className="empty-page">
      <h1>Diese Seite gibt es nicht.</h1>
      <Link className="button button-primary" to="/">Zur Startseite</Link>
    </section>
  );
}

export default function App() {
  const [popupState, setPopupState] = useState<PopupLoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function loadPopup() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}popup.md`, { cache: "no-cache" });
        if (!response.ok) {
          throw new Error(`popup.md konnte nicht geladen werden (HTTP ${response.status}).`);
        }
        const popup = parsePopupFile(await response.text());
        if (active) {
          setPopupState(popup ? { status: "loaded", popup } : { status: "empty" });
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "popup.md konnte nicht geladen werden.";
        if (active) setPopupState({ status: "error", message });
      }
    }

    void loadPopup();
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <Layout>
        <Routes>
          <Route path="/" element={<StudentHome />} />
          <Route path="/tafel/:code" element={<ProjectorDisplay />} />
          <Route path="/lehrer/*" element={<TeacherPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Layout>
      {popupState.status === "loading" ? null : popupState.status === "error" ? (
        <PopupOverlay error={`Fehler in public/popup.md: ${popupState.message}`} />
      ) : popupState.status === "loaded" ? (
        <PopupOverlay
          popup={popupState.popup}
          onDismiss={() => setPopupState({ status: "dismissed" })}
        />
      ) : null}
    </>
  );
}

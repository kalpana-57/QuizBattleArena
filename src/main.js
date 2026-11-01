import { initializeApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInAnonymously
} from "firebase/auth";

import {
  getDatabase,
  connectDatabaseEmulator,
  ref,
  get,
  set,
  update,
  onValue,
  onDisconnect,
  runTransaction
} from "firebase/database";

import { questions } from "./questions.js";
import "./style.css";

// Development always uses Firebase emulators.
// Production uses the real Firebase project unless explicitly overridden.
const useEmulators =
  import.meta.env.DEV ||
  import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true";

const projectId = useEmulators
  ? "demo-quiz-battle-arena"
  : import.meta.env.VITE_FIREBASE_PROJECT_ID;

const firebaseConfig = useEmulators
  ? {
      apiKey: "demo-key",
      authDomain: `${projectId}.firebaseapp.com`,
      databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
      projectId,
      appId: "demo-app"
    }
  : {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain:
        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ||
        `${projectId}.firebaseapp.com`,
      databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
      projectId,
      appId: import.meta.env.VITE_FIREBASE_APP_ID
    };

if (
  !useEmulators &&
  Object.values(firebaseConfig).some((value) => !value)
) {
  throw new Error(
    "Production Firebase config is incomplete. Check .env.production."
  );
}

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getDatabase(firebaseApp);

if (useEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", {
    disableWarnings: true
  });

  connectDatabaseEmulator(db, "127.0.0.1", 9000);
}

const $ = (id) => document.getElementById(id);

const elementIds = [
  "homeScreen",
  "lobbyScreen",
  "quizScreen",
  "resultScreen",
  "playerName",
  "roomCode",
  "createRoomBtn",
  "joinRoomBtn",
  "homeMessage",
  "connectionLabel",
  "lobbyRoomCode",
  "copyRoomCodeBtn",
  "playersList",
  "lobbyStatus",
  "startQuizBtn",
  "hostHint",
  "leaveLobbyBtn",
  "quizRoomCode",
  "matchRoundLabel",
  "scoreStrip",
  "answerStatusStrip",
  "questionNumber",
  "timerBar",
  "timerCircle",
  "timerDisplay",
  "questionText",
  "answerOptions",
  "answerMessage",
  "winnerText",
  "resultSubtitle",
  "resultScores",
  "rematchStatus",
  "rematchBtn",
  "declineRematchBtn",
  "leaveResultBtn",
  "toast"
];

const els = Object.fromEntries(
  elementIds.map((id) => [id, $(id)])
);

const root = "quizBattleArenaV2";

let user = null;
let roomCode = null;
let roomRef = null;

let unsubscribeRoom = null;
let unsubscribePrivateAnswer = null;

let privateAnswerQuestionId = null;
let privateAnswerReady = false;

let myAnswers = {};
let currentRoom = null;
let lastMatchNumber = null;

let tick = null;
let advanceBusy = false;

let rematchVoteInFlight = false;
let rematchVoteSubmitted = false;
let rematchStartBusy = false;

let serverOffset = 0;
let lastRenderedIndex = -1;
let toastTimer = null;

/* ---------------- BASIC HELPERS ---------------- */

function showScreen(name) {
  for (const key of [
    "homeScreen",
    "lobbyScreen",
    "quizScreen",
    "resultScreen"
  ]) {
    els[key].classList.toggle("hidden", key !== name);
  }
}

function now() {
  return Date.now() + serverOffset;
}

function roomPath(code) {
  return `${root}/rooms/${code}`;
}

function privateAnswerPath(code, questionId, uid) {
  return `${root}/privateAnswers/${code}/${questionId}/${uid}`;
}

function cleanName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 20);
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    els.toast.classList.remove("visible");
  }, 2800);
}

function setHomeMessage(message, error = false) {
  els.homeMessage.textContent = message;
  els.homeMessage.classList.toggle("error", error);
}

function setBusy(button, busy, label) {
  button.disabled = busy;

  if (busy) {
    button.dataset.oldText = button.innerHTML;
    button.innerHTML = `<span class="spinner"></span>${label}`;
  } else if (button.dataset.oldText) {
    button.innerHTML = button.dataset.oldText;
    delete button.dataset.oldText;
  }
}

function randomRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);

  crypto.getRandomValues(bytes);

  return [...bytes]
    .map((n) => alphabet[n % alphabet.length])
    .join("");
}

function currentPlayerKey(room) {
  if (user?.uid === room.hostId) return "host";
  if (user?.uid === room.guestId) return "guest";

  return null;
}

/* ---------------- ANSWER AND GAME HELPERS ---------------- */

function allAnswered(room) {
  const game = room.game;

  if (!game) return false;

  const answers =
    room.answerStatus?.[game.questionId] || {};

  return (
    Boolean(room.hostId) &&
    Boolean(room.guestId) &&
    answers.host === true &&
    answers.guest === true
  );
}

function canAdvance(room) {
  if (!room?.game || room.status !== "playing") {
    return false;
  }

  return (
    now() >= Number(room.game.endsAt) ||
    allAnswered(room)
  );
}

/* ---------------- FIREBASE INITIALIZATION ---------------- */

async function init() {
  try {
    onValue(ref(db, ".info/connected"), (snap) => {
      const online = snap.val() === true;

      els.connectionLabel.textContent = online
        ? "Arena connection ready"
        : "Reconnecting…";

      document
        .querySelector(".top-status")
        ?.classList.toggle("offline", !online);
    });

    onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
      serverOffset = snap.val() || 0;
    });

    const credential = await signInAnonymously(auth);

    user = credential.user;

    setHomeMessage(
      "You're connected. Pick a name and jump in."
    );
  } catch (error) {
    console.error("Firebase initialization failed:", error);

    setHomeMessage(
      `Could not connect: ${error.message}`,
      true
    );
  }
}

/* ---------------- CREATE ROOM ---------------- */

async function createRoom() {
  const name = cleanName(els.playerName.value);

  if (!name) {
    setHomeMessage("Enter a display name first.", true);
    return;
  }

  if (!user) {
    setHomeMessage("Still connecting. Try again.", true);
    return;
  }

  setBusy(els.createRoomBtn, true, "Creating room…");

  try {
    let created = false;

    for (let attempt = 0; attempt < 6 && !created; attempt++) {
      const code = randomRoomCode();
      const candidate = ref(db, roomPath(code));

      try {
        await set(candidate, {
          schema: 2,
          hostId: user.uid,
          hostName: name,
          guestId: "",
          guestName: "",
          status: "waiting",
          matchNumber: 0,
          createdAt: now(),
          presence: {
            [user.uid]: true
          },
          rematchVotes: {}
        });

        roomCode = code;
        roomRef = candidate;
        created = true;
      } catch (error) {
        if (error.code !== "PERMISSION_DENIED") {
          throw error;
        }
      }
    }

    if (!created) {
      throw new Error("Could not create room. Please try again.");
    }

    await listenRoom();
  } catch (error) {
    console.error("Room creation failed:", error);
    setHomeMessage(error.message, true);
  } finally {
    setBusy(els.createRoomBtn, false);
  }
}

/* ---------------- JOIN ROOM ---------------- */

async function joinRoom() {
  const name = cleanName(els.playerName.value);
  const code = els.roomCode.value.trim().toUpperCase();

  if (!name) {
    setHomeMessage("Enter a display name first.", true);
    return;
  }

  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    setHomeMessage("Enter a valid six-character room code.", true);
    return;
  }

  if (!user) {
    setHomeMessage("Still connecting. Try again.", true);
    return;
  }

  setBusy(els.joinRoomBtn, true, "Joining…");

  try {
    const candidate = ref(db, roomPath(code));
    const snapshot = await get(candidate);

    if (!snapshot.exists()) {
      throw new Error("Room not found. Check the room code.");
    }

    const room = snapshot.val();

    if (
      room.hostId === user.uid ||
      room.guestId === user.uid
    ) {
      roomCode = code;
      roomRef = candidate;

      await listenRoom();
      return;
    }

    if (room.status !== "waiting") {
      throw new Error("This quiz has already started.");
    }

    if (room.guestId) {
      throw new Error("This room is full.");
    }

    await update(candidate, {
      guestId: user.uid,
      guestName: name,
      [`presence/${user.uid}`]: true
    });

    roomCode = code;
    roomRef = candidate;

    await listenRoom();
  } catch (error) {
    console.error("Joining room failed:", error);
    setHomeMessage(error.message, true);
  } finally {
    setBusy(els.joinRoomBtn, false);
  }
}

/* ---------------- ROOM LISTENER ---------------- */

async function listenRoom() {
  unsubscribeRoom?.();
  unsubscribePrivateAnswer?.();

  unsubscribePrivateAnswer = null;
  privateAnswerQuestionId = null;
  privateAnswerReady = false;

  myAnswers = {};
  currentRoom = null;

  onValue(ref(db, ".info/connected"), async (snap) => {
    if (snap.val() && roomRef && user) {
      const presenceRef = ref(
        db,
        `${roomPath(roomCode)}/presence/${user.uid}`
      );

      try {
        await onDisconnect(presenceRef).set(false);
        await set(presenceRef, true);
      } catch (error) {
        console.error("Presence update failed:", error);
      }
    }
  });

  unsubscribeRoom = onValue(
    roomRef,
    (snap) => {
      if (!snap.exists()) {
        toast("This room is no longer available.");
        resetToHome();
        return;
      }

      renderRoom(snap.val());
    },
    (error) => {
      toast(`Room connection ended: ${error.message}`);
    }
  );
}

/* ---------------- PLAYER DISPLAY ---------------- */

function playerLabel(room, key) {
  const uid = room[`${key}Id`];

  return {
    uid,
    name:
      room[`${key}Name`] ||
      (key === "host" ? "Host" : "Challenger"),
    online: room.presence?.[uid] !== false
  };
}

function renderPlayers(room) {
  const players = [
    playerLabel(room, "host"),
    ...(room.guestId ? [playerLabel(room, "guest")] : [])
  ];

  els.playersList.innerHTML = "";

  players.forEach((player, index) => {
    const card = document.createElement("article");

    card.className = `player-card ${
      index === 0 ? "player-host" : "player-guest"
    }`;

    const badge = document.createElement("div");
    badge.className = "avatar-badge";
    badge.textContent = index === 0 ? "01" : "02";

    const info = document.createElement("div");
    info.className = "player-info";

    const name = document.createElement("strong");
    name.textContent = player.name;

    const role = document.createElement("span");

    role.textContent =
      index === 0
        ? "HOST · YOU"
        : player.uid === user.uid
          ? "CHALLENGER · YOU"
          : "CHALLENGER";

    const status = document.createElement("span");

    status.className = `player-presence ${
      player.online ? "online" : "offline"
    }`;

    status.innerHTML = `<i></i>${
      player.online ? "Connected" : "Reconnecting"
    }`;

    info.append(name, role);
    card.append(badge, info, status);

    els.playersList.append(card);
  });

  if (!room.guestId) {
    const empty = document.createElement("article");

    empty.className = "player-card player-empty";

    empty.innerHTML =
      '<div class="avatar-badge">··</div><div class="player-info"><strong>Waiting for a challenger</strong><span>Share your room code</span></div><span class="search-pulse">⌁</span>';

    els.playersList.append(empty);
  }

  const isHost = user.uid === room.hostId;
  const ready = Boolean(room.guestId);

  els.startQuizBtn.classList.toggle(
    "hidden",
    !isHost || !ready
  );

  els.hostHint.textContent = !ready
    ? "Share your code to invite a friend."
    : isHost
      ? "Both players are here. Host can start."
      : "The host will start the quiz.";

  els.lobbyStatus.innerHTML = ready
    ? '<span class="pulse-dot"></span> Two players connected · ready to battle'
    : '<span class="pulse-dot"></span> Waiting for your challenger…';
}

/* ---------------- ROOM RENDERING ---------------- */

function renderRoom(room) {
  if (
    room.hostId !== user.uid &&
    room.guestId !== user.uid
  ) {
    toast("You are not a member of this room.");
    resetToHome();
    return;
  }

  currentRoom = room;

  if (lastMatchNumber !== room.matchNumber) {
    lastMatchNumber = room.matchNumber;

    myAnswers = {};
    privateAnswerReady = false;
    privateAnswerQuestionId = null;

    unsubscribePrivateAnswer?.();
    unsubscribePrivateAnswer = null;

    lastRenderedIndex = -1;
  }

  if (room.status === "waiting") {
    showScreen("lobbyScreen");

    els.lobbyRoomCode.textContent = roomCode;

    renderPlayers(room);
    return;
  }

  if (room.status === "playing") {
    rematchVoteSubmitted = false;
    rematchStartBusy = false;

    showScreen("quizScreen");

    renderGame(room);
    return;
  }

  if (room.status === "finished") {
    unsubscribePrivateAnswer?.();

    unsubscribePrivateAnswer = null;
    privateAnswerQuestionId = null;

    clearInterval(tick);
    tick = null;

    showScreen("resultScreen");

    renderResults(room);
  }
}

/* ---------------- START QUIZ ---------------- */

async function startMatch(room, matchNumber) {
  const order = questions.map((question) => question.id);

  if (!order.length) {
    throw new Error("No quiz questions are available.");
  }

  const startedAt = now();

  const game = {
    order,
    questionIndex: 0,
    questionId: order[0],
    startedAt,
    endsAt: startedAt + 15000
  };

  if (room.status === "finished") {
    await set(
      ref(db, `${root}/privateAnswers/${roomCode}`),
      null
    );
  }

  const reset =
    room.status === "finished"
      ? {
          answerStatus: null,
          awards: null,
          rematchVotes: null
        }
      : {};

  const nextRoomState = {
    ...reset,
    status: "playing",
    game
  };

  if (room.status === "finished") {
    nextRoomState.matchNumber = matchNumber;
  }

  await update(roomRef, nextRoomState);
}

/* ---------------- WATCH PRIVATE ANSWER ---------------- */

function watchOwnAnswer(questionId) {
  if (
    privateAnswerQuestionId === questionId &&
    unsubscribePrivateAnswer
  ) {
    return;
  }

  unsubscribePrivateAnswer?.();

  privateAnswerQuestionId = questionId;
  privateAnswerReady = false;

  unsubscribePrivateAnswer = onValue(
    ref(
      db,
      privateAnswerPath(roomCode, questionId, user.uid)
    ),
    (snap) => {
      myAnswers[questionId] = snap.val() || null;
      privateAnswerReady = true;

      if (
        currentRoom?.status === "playing" &&
        currentRoom.game?.questionId === questionId
      ) {
        renderGame(currentRoom);
      }
    },
    (error) => {
      console.error("Private answer listener failed:", error);
      toast(`Your answer could not sync: ${error.message}`);
    }
  );
}

/* ---------------- ANSWER STATUS ---------------- */

function renderAnswerStatus(room, answerState) {
  els.answerStatusStrip.innerHTML = "";

  for (const key of ["host", "guest"]) {
    if (!room[`${key}Id`]) continue;

    const item = document.createElement("span");

    item.className = `answer-status-chip ${
      answerState[key] === true
        ? "answered"
        : "thinking"
    }`;

    item.textContent =
      `${room[`${key}Name`] || key}: ${
        answerState[key] === true
          ? "Answer locked"
          : "Choosing"
      }`;

    els.answerStatusStrip.append(item);
  }
}

/* ---------------- SCORE DISPLAY ---------------- */

function calculateScores(room) {
  const scores = {
    [room.hostId]: 0,
    ...(room.guestId ? { [room.guestId]: 0 } : {})
  };

  for (const answers of Object.values(room.awards || {})) {
    for (const uid of Object.keys(answers || {})) {
      scores[uid] = (scores[uid] || 0) + 10;
    }
  }

  return scores;
}

function renderScores(room) {
  const scores = calculateScores(room);

  els.scoreStrip.innerHTML = "";

  for (const key of ["host", "guest"]) {
    const uid = room[`${key}Id`];

    if (!uid) continue;

    const item = document.createElement("div");

    item.className = `score-chip ${
      uid === user.uid ? "score-self" : ""
    }`;

    const name = document.createElement("span");
    name.textContent = room[`${key}Name`] || key;

    const score = document.createElement("strong");
    score.textContent = scores[uid] || 0;

    const points = document.createElement("small");
    points.textContent = "PTS";

    item.append(name, score, points);

    els.scoreStrip.append(item);
  }
}

/* ---------------- GAME DISPLAY ---------------- */

function renderGame(room) {
  const game = room.game;

  if (
    !game ||
    game.questionIndex >= game.order.length
  ) {
    return;
  }

  els.quizRoomCode.textContent = roomCode;

  els.matchRoundLabel.textContent =
    `MATCH ${room.matchNumber + 1}`;

  renderScores(room);

  const qIndex = game.questionIndex;
  const qid = game.order[qIndex];

  const question = questions.find(
    (item) => item.id === qid
  );

  if (!question) {
    toast("Question data is missing.");
    return;
  }

  watchOwnAnswer(qid);

  els.questionNumber.textContent =
    `QUESTION ${String(qIndex + 1).padStart(2, "0")} / ${game.order.length}`;

  els.questionText.textContent = question.prompt;

  if (qIndex !== lastRenderedIndex) {
    lastRenderedIndex = qIndex;

    els.answerMessage.textContent =
      "Choose your answer before time runs out.";
  }

  els.answerOptions.innerHTML = "";

  const myAnswer = myAnswers[qid] || null;
  const mySeat = currentPlayerKey(room);

  const otherSeat =
    mySeat === "host" ? "guest" : "host";

  const answerState =
    room.answerStatus?.[qid] || {};

  const opponentAnswered =
    answerState[otherSeat] === true;

  renderAnswerStatus(room, answerState);

  question.choices.forEach((choice, index) => {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "answer-option";

    const key = document.createElement("span");
    key.className = "option-key";
    key.textContent = String.fromCharCode(65 + index);

    const label = document.createElement("span");
    label.className = "option-label";
    label.textContent = choice;

    button.append(key, label);

    button.disabled =
      !privateAnswerReady ||
      Boolean(myAnswer) ||
      now() >= Number(game.endsAt);

    if (myAnswer && myAnswer.choice === index) {
      button.classList.add("selected");
    }

    button.addEventListener("click", () => {
      submitAnswer(room, index);
    });

    els.answerOptions.append(button);
  });

  if (myAnswer) {
    els.answerMessage.textContent = opponentAnswered
      ? "Both answers are in. Advancing the round…"
      : "Answer locked. Waiting for your opponent…";
  }

  startCountdown(game.endsAt);

  if (canAdvance(room)) {
    void advanceGame(room);
  }
}

/* ---------------- COUNTDOWN ---------------- */

function startCountdown(deadline) {
  clearInterval(tick);
  tick = null;

  const expectedDeadline = Number(deadline);

  const updateTimer = () => {
    const remaining = expectedDeadline - now();

    const left = Math.max(
      0,
      Math.ceil(remaining / 1000)
    );

    els.timerDisplay.textContent =
      String(left).padStart(2, "0");

    els.timerBar.style.transform =
      `scaleX(${Math.max(0, remaining / 15000)})`;

    els.timerCircle.classList.toggle(
      "urgent",
      left <= 5
    );

    if (left <= 0) {
      clearInterval(tick);
      tick = null;

      for (const button of els.answerOptions.querySelectorAll("button")) {
        button.disabled = true;
      }

      els.answerMessage.textContent =
        "Time is up. Moving to the next question…";

      console.log("TIMER EXPIRED", {
        deadline: expectedDeadline,
        currentTime: now(),
        questionId: currentRoom?.game?.questionId
      });

      if (
        currentRoom?.status === "playing" &&
        Number(currentRoom.game?.endsAt) === expectedDeadline
      ) {
        void advanceGame(currentRoom);
      }
    }
  };

  updateTimer();

  if (expectedDeadline > now()) {
    tick = setInterval(updateTimer, 120);
  }
}

/* ---------------- SUBMIT ANSWER ---------------- */

async function submitAnswer(room, choice) {
  const questionId = room.game.questionId;
  const seat = currentPlayerKey(room);

  if (!seat) return;

  if (now() >= Number(room.game.endsAt)) {
    toast("Time is up. You cannot answer.");
    return;
  }

  if (myAnswers[questionId]) {
    toast("You have already answered this question.");
    return;
  }

  const answerRef = ref(
    db,
    privateAnswerPath(roomCode, questionId, user.uid)
  );

  for (const button of els.answerOptions.querySelectorAll("button")) {
    button.disabled = true;
  }

  let answerSaved = false;

  try {
    // Save the player's private answer.
    await set(answerRef, {
      choice,
      submittedAt: now()
    });

    answerSaved = true;

    // Request the points award from Firebase.
    // Firebase checks the private answer against the protected answer key.
    const awardRef = ref(
      db,
      `${roomPath(roomCode)}/awards/${questionId}/${user.uid}`
    );

    try {
      await set(awardRef, 10);

      console.log("Score award confirmed:", {
        questionId,
        choice,
        points: 10
      });

    } catch (error) {
      if (error.code === "PERMISSION_DENIED") {
        // An incorrect answer is expected to be rejected.
        // Do not show the misleading connection/rules toast.
        console.info(
          "No points awarded. Firebase rejected the answer."
        );
      } else {
        console.error("Score award failed:", error);

        toast(
          "There was a problem updating your score. Please check your connection."
        );
      }
    }

    // Mark this player as having answered.
    await set(
      ref(
        db,
        `${roomPath(roomCode)}/answerStatus/${questionId}/${seat}`
      ),
      true
    );

    els.answerMessage.textContent =
      "Answer locked. Waiting for your opponent…";

  } catch (error) {
    console.error("Answer submission failed:", error);

    toast(
      answerSaved
        ? "Answer saved, but answer status could not sync."
        : error.code === "PERMISSION_DENIED"
          ? "Firebase rejected your answer. Check the timer or Firebase rules."
          : `Could not save your answer: ${error.message}`
    );

    if (!answerSaved) {
      renderGame(currentRoom || room);
    }
  }
}

/* ---------------- ADVANCE QUESTION ---------------- */

async function advanceGame(room) {
  if (
    advanceBusy ||
    !room?.game ||
    room.status !== "playing" ||
    !canAdvance(room)
  ) {
    return;
  }

  advanceBusy = true;

  try {
    const oldGame = room.game;

    const gameRef = ref(
      db,
      `${roomPath(roomCode)}/game`
    );

    const result = await runTransaction(
      gameRef,
      (game) => {
        if (
          !game ||
          game.questionIndex !== oldGame.questionIndex ||
          game.questionId !== oldGame.questionId
        ) {
          return;
        }

        const latestAnswers =
          currentRoom?.answerStatus?.[game.questionId] || {};

        const bothAnswered =
          latestAnswers.host === true &&
          latestAnswers.guest === true;

        const expired = now() >= Number(game.endsAt);

        if (!expired && !bothAnswered) {
          return;
        }

        const nextIndex = game.questionIndex + 1;

        if (nextIndex >= game.order.length) {
          return {
            ...game,
            questionIndex: game.order.length,
            endsAt: 0
          };
        }

        const startedAt = now();

        return {
          ...game,
          questionIndex: nextIndex,
          questionId: game.order[nextIndex],
          startedAt,
          endsAt: startedAt + 15000
        };
      },
      {
        applyLocally: false
      }
    );

    console.log("QUESTION ADVANCE RESULT", {
      committed: result.committed,
      game: result.snapshot.val()
    });

    if (result.committed) {
      const updatedGame = result.snapshot.val();

      if (
        updatedGame &&
        updatedGame.questionIndex >= updatedGame.order.length
      ) {
        await update(roomRef, {
          status: "finished"
        });
      }
    }
  } catch (error) {
    console.error("Could not advance question:", error);

    toast(
      error.code === "PERMISSION_DENIED"
        ? "Firebase rules blocked question advancement."
        : `Could not advance: ${error.message}`
    );
  } finally {
    advanceBusy = false;
  }
}

/* ---------------- RESULTS ---------------- */

function renderResults(room) {
  const scores = calculateScores(room);

  const hostScore = scores[room.hostId] || 0;
  const guestScore = scores[room.guestId] || 0;

  const winner =
    hostScore === guestScore
      ? null
      : hostScore > guestScore
        ? "host"
        : "guest";

  els.winnerText.textContent = winner
    ? `${room[`${winner}Name`]} wins!`
    : "It's a draw!";

  els.resultSubtitle.textContent = winner
    ? "A brilliant battle. The arena has its champion."
    : "Perfectly matched. What a battle.";

  els.resultScores.innerHTML = "";

  for (const key of ["host", "guest"]) {
    const card = document.createElement("div");

    card.className = `result-score ${
      winner === key ? "result-winner" : ""
    }`;

    const name = document.createElement("span");
    name.textContent = room[`${key}Name`] || key;

    const score = document.createElement("strong");
    score.textContent =
      scores[room[`${key}Id`]] || 0;

    const label = document.createElement("small");
    label.textContent =
      winner === key ? "CHAMPION" : "POINTS";

    card.append(name, score, label);

    els.resultScores.append(card);
  }

  const votes = room.rematchVotes || {};

  const yesCount = [
    votes.host,
    votes.guest
  ].filter((vote) => vote === true).length;

  const mySeat =
    user.uid === room.hostId ? "host" : "guest";

  const myVote = votes[mySeat];

  const hasVoted =
    myVote === true || rematchVoteSubmitted;

  els.rematchStatus.textContent =
    myVote === true || rematchVoteSubmitted
      ? yesCount === 2
        ? "Both players are ready. Starting rematch…"
        : "You're in. Waiting for your opponent…"
      : myVote === false
        ? "You passed for now. You can still request a rematch."
        : `${yesCount}/2 players ready for a rematch.`;

  els.rematchBtn.disabled =
    hasVoted || rematchVoteInFlight;

  els.rematchBtn.innerHTML =
    hasVoted
      ? "Rematch requested <span>✓</span>"
      : "Request rematch <span>↻</span>";

  els.declineRematchBtn.textContent =
    hasVoted ? "Request sent" : "Maybe later";

  els.declineRematchBtn.disabled =
    hasVoted || rematchVoteInFlight;

  if (
    yesCount === 2 &&
    user.uid === room.hostId
  ) {
    void beginRematch(room);
  }
}

/* ---------------- REMATCH ---------------- */

async function voteRematch(accept) {
  if (
    !roomRef ||
    rematchVoteInFlight ||
    rematchVoteSubmitted
  ) {
    return;
  }

  rematchVoteInFlight = true;

  els.rematchBtn.disabled = true;
  els.declineRematchBtn.disabled = true;

  try {
    const snapshot = await get(roomRef);
    const room = snapshot.val();

    if (!room || room.status !== "finished") {
      return;
    }

    const seat =
      user.uid === room.hostId
        ? "host"
        : user.uid === room.guestId
          ? "guest"
          : null;

    if (!seat) return;

    await set(
      ref(
        db,
        `${roomPath(roomCode)}/rematchVotes/${seat}`
      ),
      accept
    );

    rematchVoteSubmitted = accept;
  } catch (error) {
    console.error("Rematch vote failed:", error);

    toast(`Could not save your choice: ${error.message}`);
  } finally {
    rematchVoteInFlight = false;

    if (currentRoom) {
      renderResults(currentRoom);
    }
  }
}

async function beginRematch(room) {
  if (
    rematchStartBusy ||
    user.uid !== room.hostId ||
    room.status !== "finished"
  ) {
    return;
  }

  const votes = room.rematchVotes || {};

  if (
    votes.host !== true ||
    votes.guest !== true
  ) {
    return;
  }

  rematchStartBusy = true;

  try {
    await startMatch(room, room.matchNumber + 1);
  } catch (error) {
    console.error("Rematch start failed:", error);

    toast(`Could not start rematch: ${error.message}`);
  } finally {
    rematchStartBusy = false;
  }
}

/* ---------------- COPY ROOM CODE ---------------- */

async function copyCode() {
  try {
    await navigator.clipboard.writeText(roomCode);

    toast("Room code copied!");
  } catch {
    toast(`Room code: ${roomCode}`);
  }
}

/* ---------------- LEAVE ROOM ---------------- */

function resetToHome() {
  unsubscribeRoom?.();
  unsubscribeRoom = null;

  unsubscribePrivateAnswer?.();
  unsubscribePrivateAnswer = null;

  privateAnswerQuestionId = null;
  privateAnswerReady = false;

  currentRoom = null;
  myAnswers = {};

  lastMatchNumber = null;

  clearInterval(tick);
  tick = null;

  roomCode = null;
  roomRef = null;

  advanceBusy = false;

  rematchVoteInFlight = false;
  rematchVoteSubmitted = false;
  rematchStartBusy = false;

  lastRenderedIndex = -1;

  showScreen("homeScreen");
}

function leaveRoom() {
  resetToHome();
}

/* ---------------- BUTTON EVENTS ---------------- */

els.createRoomBtn.addEventListener(
  "click",
  createRoom
);

els.joinRoomBtn.addEventListener(
  "click",
  joinRoom
);

els.roomCode.addEventListener("input", () => {
  els.roomCode.value = els.roomCode.value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "")
    .slice(0, 6);
});

els.roomCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    joinRoom();
  }
});

els.copyRoomCodeBtn.addEventListener(
  "click",
  copyCode
);

els.startQuizBtn.addEventListener(
  "click",
  async () => {
    try {
      const snapshot = await get(roomRef);
      const room = snapshot.val();

      if (!room || user.uid !== room.hostId) {
        return;
      }

      await startMatch(room, room.matchNumber);
    } catch (error) {
      console.error("Starting quiz failed:", error);

      toast(`Could not start: ${error.message}`);
    }
  }
);

els.leaveLobbyBtn.addEventListener(
  "click",
  leaveRoom
);

els.leaveResultBtn.addEventListener(
  "click",
  leaveRoom
);

els.rematchBtn.addEventListener(
  "click",
  () => voteRematch(true)
);

els.declineRematchBtn.addEventListener(
  "click",
  () => voteRematch(false)
);

/* ---------------- CLEANUP ---------------- */

window.addEventListener("beforeunload", () => {
  unsubscribeRoom?.();
  unsubscribePrivateAnswer?.();

  clearInterval(tick);
});

onValue(ref(db, ".info/connected"), (snap) => {
  if (!snap.val() && tick) {
    clearInterval(tick);
    tick = null;
  }
});

/* ---------------- START APPLICATION ---------------- */

init();
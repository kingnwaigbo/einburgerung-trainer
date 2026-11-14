/**
 * Einbürgerung Trainer – Cham & Zug
 * Full Offline Learning Engine with SM-2 Spaced Repetition, Quiz System, & Speech Synthesis.
 */

// IndexedDB Storage Layer
const DB_NAME = 'EinbuergerungChamDB';
const DB_VERSION = 1;
const PROGRESS_STORAGE_KEY = 'einbuergerungProgress';

class LearningDB {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('questions')) {
          db.createObjectStore('questions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('user_progress')) {
          db.createObjectStore('user_progress', { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };
      request.onerror = (e) => reject(e);
    });
  }

  async getAllQuestions() {
    return new Promise((resolve) => {
      const tx = this.db.transaction('questions', 'readonly');
      const store = tx.objectStore('questions');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  }

async saveQuestions(questions) {
  return new Promise((resolve, reject) => {
    const tx = this.db.transaction('questions', 'readwrite');
    const store = tx.objectStore('questions');

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    for (const q of questions) {
      store.put(q);
    }
  });
}

  async getProgress(id) {
    return new Promise((resolve) => {
      const tx = this.db.transaction('user_progress', 'readonly');
      const req = tx.objectStore('user_progress').get(id);
      req.onsuccess = () => resolve(req.result || null);
    });
  }

  async getAllProgress() {
    let localProgress = [];
    try {
      localProgress = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) || '[]');
      if (!Array.isArray(localProgress)) {
        throw new Error('Gespeicherter Lernfortschritt hat ein ungültiges Format.');
      }
    } catch (error) {
      console.warn(`Lokaler Lernfortschritt konnte nicht geladen werden: ${error.message}`);
      localProgress = [];
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('user_progress', 'readonly');
      const req = tx.objectStore('user_progress').getAll();
      req.onsuccess = () => {
        const progressById = new Map((req.result || []).map(progress => [progress.id, progress]));
        localProgress.forEach(progress => {
          const stored = progressById.get(progress.id);
          if (!stored) {
            progressById.set(progress.id, progress);
            return;
          }

          const merged = { ...stored, ...progress };
          if (new Date(stored.lastReviewed || 0) > new Date(progress.lastReviewed || 0)) {
            ['repetitions', 'interval', 'easinessFactor', 'dueDate', 'lastReviewed'].forEach(key => {
              if (stored[key] !== undefined) merged[key] = stored[key];
            });
          }
          if (new Date(stored.lastQuizAnswer?.answeredAt || 0) > new Date(progress.lastQuizAnswer?.answeredAt || 0)) {
            merged.lastQuizAnswer = stored.lastQuizAnswer;
          }
          progressById.set(progress.id, merged);
        });
        const progress = Array.from(progressById.values());
        try {
          localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
        } catch (error) {
          console.warn(`Lernfortschritt konnte nicht gespiegelt werden: ${error.message}`);
        }
        resolve(progress);
      };
      req.onerror = () => {
        if (localProgress.length > 0) resolve(localProgress);
        else reject(req.error || tx.error);
      };
    });
  }

  async saveProgress(progressObj) {
    const errors = [];
    let localSaved = false;
    let databaseSaved = false;
    try {
      const progress = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) || '[]');
      const progressById = new Map(progress.map(item => [item.id, item]));
      progressById.set(progressObj.id, progressObj);
      localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(Array.from(progressById.values())));
      localSaved = true;
    } catch (error) {
      errors.push(error);
    }

    try {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('user_progress', 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);

        tx.objectStore('user_progress').put(progressObj);
      });
      databaseSaved = true;
    } catch (error) {
      errors.push(error);
    }

    if (!localSaved && !databaseSaved) {
      throw new Error(`Lernfortschritt konnte nicht gespeichert werden: ${errors.map(error => error.message).join('; ')}`);
    }
  }

} // Closes the LearningDB class
  
// App Core Controller
class App {
  constructor() {
    this.db = new LearningDB();
    this.questions = [];
    this.flashcardQuestions = [];
    this.progressMap = new Map();
    this.currentFCIndex = 0;
    this.flashcardRatingPending = false;
    this.learningQueueStore = new LearningQueue(localStorage);
    this.learningQueue = null;
    this.interviewQuestions = [];
    this.currentInterviewIndex = 0;
    this.interviewRecognition = null;
    this.interviewTranscript = '';
    this.interviewTimerInterval = null;
    this.interviewStartedAt = null;
    this.activeQuiz = null;
    this.walkingIndex = 0;
    this.speechSynth = window.speechSynthesis;
    this.isRecording = false;
  }

  async init() {
    await this.db.init();
    this.questions = await this.db.getAllQuestions();
    
    // Load default questions if DB is empty
    if (this.questions.length === 0) {
      const res = await fetch('questions.json');
      const defaultData = await res.json();
      this.questions = defaultData.questions || defaultData;
      await this.db.saveQuestions(this.questions);
    }

    const progressList = await this.db.getAllProgress();
    progressList.forEach(p => this.progressMap.set(p.id, p));
    this.learningQueue = this.learningQueueStore.load(this.questions, this.progressMap);

    this.updateDashboard();
    this.registerServiceWorker();
  }


  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              document.getElementById('updateBanner').classList.remove('hidden');
            }
          });
        });
      });
    }
  }


  showScreen(screenId) {
    document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
    const target = document.getElementById(`screen-${screenId}`);
    if (target) target.classList.remove('hidden');

    if (screenId === 'flashcards') this.loadFlashcards();
    if (screenId === 'interview') this.loadInterviewQuestion();
    if (screenId !== 'interview') this.stopInterviewTimer();
    if (screenId === 'dashboard') this.updateDashboard();
  }

  loadInterviewQuestion() {
    if (this.interviewRecognition && this.isRecording) {
      this.interviewRecognition.stop();
    }

    this.interviewQuestions = this.questions.filter(q => q.type === 'interview');
    if (this.interviewQuestions.length === 0) {
      this.interviewQuestions = this.questions;
    }

    if (this.interviewQuestions.length === 0) {
      document.getElementById('intQuestionText').textContent = 'Keine Interviewfragen vorhanden.';
      document.getElementById('intSubtopic').textContent = '';
      document.getElementById('intMicBtn').disabled = true;
      document.querySelectorAll('#screen-interview button[onclick^="app.rateInterview"]').forEach(button => { button.disabled = true; });
      return;
    }

    this.interviewQuestions.sort((a, b) => {
      const aProgress = this.progressMap.get(a.id);
      const bProgress = this.progressMap.get(b.id);
      if (!aProgress?.interviewRatedAt) return bProgress?.interviewRatedAt ? -1 : 0;
      if (!bProgress?.interviewRatedAt) return 1;
      return new Date(aProgress.interviewRatedAt) - new Date(bProgress.interviewRatedAt);
    });
    this.currentInterviewIndex = 0;
    this.displayInterviewQuestion();
  }

  displayInterviewQuestion() {
    const q = this.interviewQuestions[this.currentInterviewIndex];
    if (!q) return;

    this.interviewTranscript = '';
    this.interviewStartedAt = Date.now();
    document.getElementById('intSubtopic').textContent = q.subtopic || q.topic || 'Interview';
    document.getElementById('intQuestionText').textContent = q.question;
    document.getElementById('intSpeechTranscript').textContent = 'Sprechen Sie jetzt...';
    document.getElementById('intSpeechOutput').classList.add('hidden');
    document.getElementById('intModelAnswerBox').classList.add('hidden');
    this.startInterviewTimer();

    const savedRating = this.progressMap.get(q.id)?.interviewRating;
    document.querySelectorAll('#screen-interview button[onclick^="app.rateInterview"]').forEach(button => {
      button.disabled = false;
      button.classList.toggle('ring-2', Number(button.getAttribute('onclick').match(/\d+/)?.[0]) === savedRating);
    });
  }

  startInterviewTimer() {
    this.stopInterviewTimer();
    const updateTimer = () => {
      const elapsedSeconds = Math.floor((Date.now() - this.interviewStartedAt) / 1000);
      const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
      const seconds = String(elapsedSeconds % 60).padStart(2, '0');
      document.getElementById('intTimer').textContent = `⏱️ ${minutes}:${seconds}`;
    };
    updateTimer();
    this.interviewTimerInterval = setInterval(updateTimer, 1000);
  }

  stopInterviewTimer() {
    if (this.interviewTimerInterval) {
      clearInterval(this.interviewTimerInterval);
      this.interviewTimerInterval = null;
    }
  }

  toggleModelAnswer() {
    const q = this.interviewQuestions[this.currentInterviewIndex];
    if (!q) return;

    const answerBox = document.getElementById('intModelAnswerBox');
    const isHidden = answerBox.classList.toggle('hidden');
    if (isHidden) return;

    document.getElementById('intModelAnswer').textContent = q.correct_answer || 'Keine Musterantwort hinterlegt.';
    const keyPoints = document.getElementById('intKeyPoints');
    keyPoints.innerHTML = '';
    const points = (q.explanation || q.correct_answer || '').split(/(?<=[.!?])\s+|;\s+/).filter(Boolean);
    points.forEach(point => {
      const item = document.createElement('li');
      item.textContent = point;
      keyPoints.appendChild(item);
    });
  }

  toggleInterviewMic() {
    if (this.isRecording) {
      this.interviewRecognition.stop();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Spracherkennung wird von diesem Browser nicht unterstützt. Sie können Ihre Antwort trotzdem selbst bewerten.');
      return;
    }

    const recognition = new SpeechRecognition();
    this.interviewRecognition = recognition;
    recognition.lang = 'de-CH';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      this.isRecording = true;
      document.getElementById('intMicText').textContent = 'Aufnahme stoppen';
      document.getElementById('intSpeechOutput').classList.remove('hidden');
      document.getElementById('intSpeechTranscript').textContent = 'Sprechen Sie jetzt...';
    };
    recognition.onresult = event => {
      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) this.interviewTranscript += `${transcript} `;
        else interimTranscript += `${transcript} `;
      }
      document.getElementById('intSpeechTranscript').textContent =
        `${this.interviewTranscript}${interimTranscript}`.trim() || 'Sprechen Sie jetzt...';
    };
    recognition.onerror = event => {
      this.isRecording = false;
      document.getElementById('intMicText').textContent = 'Antwort Aufnehmen';
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        document.getElementById('intSpeechOutput').classList.remove('hidden');
        document.getElementById('intSpeechTranscript').textContent = `Aufnahmefehler: ${event.error}`;
      }
    };
    recognition.onend = () => {
      this.isRecording = false;
      document.getElementById('intMicText').textContent = 'Antwort Aufnehmen';
    };

    try {
      recognition.start();
    } catch (error) {
      this.isRecording = false;
      alert(`Aufnahme konnte nicht gestartet werden: ${error.message}`);
    }
  }

  async rateInterview(rating) {
    const q = this.interviewQuestions[this.currentInterviewIndex];
    if (!q || ![1, 2, 3].includes(rating)) return;

    const existing = this.progressMap.get(q.id) || { id: q.id };
    const updatedProgress = {
      ...existing,
      interviewRating: rating,
      interviewRatedAt: new Date().toISOString(),
      interviewTranscript: this.interviewTranscript.trim(),
      interviewDurationSeconds: Math.floor((Date.now() - this.interviewStartedAt) / 1000)
    };
    const ratingButtons = document.querySelectorAll('#screen-interview button[onclick^="app.rateInterview"]');
    ratingButtons.forEach(button => { button.disabled = true; });

    try {
      await this.db.saveProgress(updatedProgress);
    } catch (error) {
      ratingButtons.forEach(button => { button.disabled = false; });
      alert(error.message);
      return;
    }

    this.progressMap.set(q.id, updatedProgress);
    if (this.interviewRecognition && this.isRecording) this.interviewRecognition.stop();
    this.currentInterviewIndex = (this.currentInterviewIndex + 1) % this.interviewQuestions.length;
    this.displayInterviewQuestion();
  }

  startSmartSession() {
    const flashcards = this.questions.filter(q => q.type === 'flashcard');
    if (flashcards.length > 0) {
      if (!this.learningQueue || this.learningQueue.completed) {
        this.learningQueue = this.learningQueueStore.startNew(this.questions, this.progressMap);
      }
      this.showScreen('flashcards');
      return;
    }

    if (this.questions.some(q => q.type === 'multiple_choice' || q.options)) {
      this.showScreen('quiz');
      this.startQuiz();
      return;
    }

    alert('Keine Fragen für eine Smart-Session vorhanden.');
  }

  toggleDarkMode() {
    document.documentElement.classList.toggle('dark');
  }

  // --- SM-2 SPACED REPETITION ENGINE ---
  calculateSM2(quality, repetitions, interval, easinessFactor) {
    let nextRepetitions = repetitions;
    let nextInterval = interval;
    let nextEF = easinessFactor;

    if (quality >= 3) {
      if (repetitions === 0) nextInterval = 1;
      else if (repetitions === 1) nextInterval = 6;
      else nextInterval = Math.round(interval * easinessFactor);
      nextRepetitions += 1;
    } else {
      nextRepetitions = 0;
      nextInterval = 1;
    }

    nextEF = easinessFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (nextEF < 1.3) nextEF = 1.3;

    const nextDueDate = new Date();
    nextDueDate.setDate(nextDueDate.getDate() + nextInterval);

    return {
      repetitions: nextRepetitions,
      interval: nextInterval,
      easinessFactor: nextEF,
      dueDate: nextDueDate.toISOString()
    };
  }

  async rateFlashcard(quality) {
    const q = this.flashcardQuestions[this.currentFCIndex];
    if (!q || this.flashcardRatingPending) return;
    this.flashcardRatingPending = true;
    const ratingButtons = document.querySelectorAll('#fcRatingButtons button');
    ratingButtons.forEach(button => { button.disabled = true; });

    const existing = this.progressMap.get(q.id) || {
      id: q.id,
      repetitions: 0,
      interval: 1,
      easinessFactor: 2.5,
      dueDate: new Date().toISOString()
    };

    const updated = {
      ...existing,
      ...this.calculateSM2(quality, existing.repetitions, existing.interval, existing.easinessFactor),
      lastReviewed: new Date().toISOString()
    };

    try {
      await this.db.saveProgress(updated);
    } catch (error) {
      this.flashcardRatingPending = false;
      ratingButtons.forEach(button => { button.disabled = false; });
      alert(error.message);
      return;
    }
    this.progressMap.set(q.id, updated);

    try {
      this.learningQueueStore.completeCurrent(q.id);
    } catch (error) {
      alert(`Fortschritt wurde gespeichert, aber die Kartenposition konnte nicht gespeichert werden: ${error.message}`);
    }

    this.learningQueue = this.learningQueueStore.state;
    this.syncFlashcardQuestions();
    this.flashcardRatingPending = false;
    ratingButtons.forEach(button => { button.disabled = false; });
    document.getElementById('cardInner').classList.remove('flipped');
    this.updateDashboard();
    setTimeout(() => this.displayCurrentFlashcard(), 300);
  }

  // --- FLASHCARD MODE ---

  syncFlashcardQuestions() {
    const questionsById = new Map(
      this.questions
        .filter(question => question.type === 'flashcard')
        .map(question => [question.id, question])
    );
    this.flashcardQuestions = (this.learningQueue?.pendingQuestionIds || [])
      .map(id => questionsById.get(id))
      .filter(Boolean);
    this.currentFCIndex = 0;
  }

  loadFlashcards() {
    this.learningQueueStore.state = this.learningQueue;
    this.learningQueue = this.learningQueueStore.reconcile(this.questions, this.progressMap);
    this.learningQueue = this.learningQueueStore.state;
    this.syncFlashcardQuestions();

    if (this.flashcardQuestions.length === 0) {
      const cardInner = document.getElementById('cardInner');
      const ratingButtons = document.getElementById('fcRatingButtons');
      const completed = this.learningQueue?.completed;
      document.getElementById('flashcardCounter').textContent = completed ? 'Lerneinheit abgeschlossen' : '0 / 0';
      document.getElementById('fcTopicFront').textContent = '';
      document.getElementById('fcDiffFront').textContent = '';
      document.getElementById('fcQuestionFront').textContent =
        completed ? 'Alle aktuell fälligen und ungelernten Karten sind bewertet.' : 'Keine Karteikarten vorhanden.';
      document.getElementById('fcTopicBack').textContent = '';
      document.getElementById('fcAnswerBack').textContent = '';
      document.getElementById('fcExplanationBack').textContent = '';
      document.getElementById('fcSourceBack').textContent = '';
      ratingButtons.classList.add('hidden');
      cardInner.classList.remove('flipped');
      return;
    }

    document.getElementById('fcRatingButtons').classList.remove('hidden');
    document.getElementById('cardInner').classList.remove('flipped');
    this.displayCurrentFlashcard();
  }

  displayCurrentFlashcard() {
    const q = this.flashcardQuestions[this.currentFCIndex];
    if (!q) {
      this.loadFlashcards();
      return;
    }

    const completedCount = this.learningQueue.completedQuestionIds.length;
    const sessionTotal = completedCount + this.learningQueue.pendingQuestionIds.length;
    document.getElementById('flashcardCounter').textContent =
      `${completedCount + 1} / ${sessionTotal}`;
    document.getElementById('fcTopicFront').textContent = q.topic;
    document.getElementById('fcDiffFront').textContent = q.difficulty || 'Mittel';
    document.getElementById('fcQuestionFront').textContent = q.question;

    document.getElementById('fcTopicBack').textContent = q.topic;
    document.getElementById('fcAnswerBack').textContent = q.correct_answer;
    document.getElementById('fcExplanationBack').textContent = q.explanation || '';
    document.getElementById('fcSourceBack').textContent = `Quelle: ${q.source.title} (${q.source.year})`;
  }

  flipCard() {
    document.getElementById('cardInner').classList.toggle('flipped');
  }

  // --- QUIZ MODE ENGINE ---
  setQuizLength(len) {
    document.querySelectorAll('.quiz-len-btn').forEach(b => b.classList.remove('border-swiss-red', 'bg-red-50', 'text-swiss-red'));
    event.target.classList.add('border-swiss-red', 'bg-red-50', 'text-swiss-red');
    this.quizSelectedLen = len;
  }

  startQuiz() {
    const topic = document.getElementById('quizTopicSelect').value;
    let pool = this.questions.filter(q => q.type === 'multiple_choice' || q.options);
    if (topic !== 'all') {
      pool = pool.filter(q => q.subtopic === topic || q.topic === topic);
    }
    
    if (pool.length === 0) pool = this.questions; // Fallback

    pool = pool.sort(() => Math.random() - 0.5);
    const limit = this.quizSelectedLen || 5;
    
    this.activeQuiz = {
      questions: pool.slice(0, limit),
      currentIndex: 0,
      score: 0
    };

    document.getElementById('quizSetup').classList.add('hidden');
    document.getElementById('quizExecution').classList.remove('hidden');
    this.renderQuizQuestion();
  }

  renderQuizQuestion() {
    const q = this.activeQuiz.questions[this.activeQuiz.currentIndex];
    this.activeQuiz.answered = false;
    this.activeQuiz.answerPending = false;
    document.getElementById('quizFeedbackBox').classList.add('hidden');
    document.getElementById('quizProgressText').textContent = `Frage ${this.activeQuiz.currentIndex + 1} von ${this.activeQuiz.questions.length}`;
    document.getElementById('quizScoreText').textContent = `Punkte: ${this.activeQuiz.score}`;
    document.getElementById('quizTopicBadge').textContent = q.topic;
    document.getElementById('quizQuestionText').textContent = q.question;

    const container = document.getElementById('quizOptionsContainer');
    container.innerHTML = '';

    const savedAnswer = this.progressMap.get(q.id)?.lastQuizAnswer;
    if (savedAnswer) {
      const savedAnswerText = document.createElement('p');
      savedAnswerText.className = 'text-xs text-slate-500 dark:text-slate-400 mb-2';
      savedAnswerText.textContent = `Zuletzt gespeichert: ${savedAnswer.selected} (${savedAnswer.isCorrect ? 'richtig' : 'nicht richtig'})`;
      container.appendChild(savedAnswerText);
    }

    const opts = [...q.options].sort(() => Math.random() - 0.5);
    opts.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'w-full text-left p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 font-medium text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition';
      btn.textContent = opt;
      btn.onclick = () => this.handleQuizAnswer(opt, q.correct_answer, q);
      container.appendChild(btn);
    });
  }

  async handleQuizAnswer(selected, correct, q) {
    if (this.activeQuiz.answered || this.activeQuiz.answerPending) return;

    const isCorrect = selected === correct;
    this.activeQuiz.answerPending = true;
    const optionButtons = document.querySelectorAll('#quizOptionsContainer button');
    optionButtons.forEach(button => { button.disabled = true; });

    const updatedProgress = {
      ...(this.progressMap.get(q.id) || { id: q.id }),
      lastQuizAnswer: {
        selected,
        isCorrect,
        answeredAt: new Date().toISOString()
      }
    };

    try {
      await this.db.saveProgress(updatedProgress);
    } catch (error) {
      this.activeQuiz.answerPending = false;
      optionButtons.forEach(button => { button.disabled = false; });
      alert(`Antwort konnte nicht gespeichert werden: ${error.message}`);
      return;
    }

    this.progressMap.set(q.id, updatedProgress);
    this.activeQuiz.answered = true;
    this.activeQuiz.answerPending = false;
    if (isCorrect) this.activeQuiz.score += 1;

    const box = document.getElementById('quizFeedbackBox');
    box.classList.remove('hidden', 'bg-green-50', 'bg-red-50', 'dark:bg-green-950', 'dark:bg-red-950');
    box.classList.add(isCorrect ? 'bg-green-50' : 'bg-red-50');

    document.getElementById('quizFeedbackTitle').textContent = isCorrect ? 'Richtig! 🎉' : 'Leider nicht ganz korrekt ❌';
    document.getElementById('quizFeedbackTitle').className = isCorrect ? 'font-bold text-green-700 text-sm' : 'font-bold text-red-700 text-sm';
    document.getElementById('quizExplanationText').textContent = q.explanation || `Richtige Antwort: ${correct}`;
    document.getElementById('quizSourceText').textContent = `Quelle: ${q.source.title}`;
  }

  nextQuizQuestion() {
    this.activeQuiz.currentIndex += 1;
    if (this.activeQuiz.currentIndex >= this.activeQuiz.questions.length) {
      alert(`Quiz beendet! Ihr Resultat: ${this.activeQuiz.score} / ${this.activeQuiz.questions.length}`);
      document.getElementById('quizExecution').classList.add('hidden');
      document.getElementById('quizSetup').classList.remove('hidden');
    } else {
      this.renderQuizQuestion();
    }
  }

  // --- AUDIO WALKING MODE ---
  toggleWalkingAudio() {
    if (this.speechSynth.speaking) {
      this.speechSynth.cancel();
      document.getElementById('walkPlayBtn').textContent = '▶';
    } else {
      this.playWalkingQuestion();
      document.getElementById('walkPlayBtn').textContent = '⏸';
    }
  }

  playWalkingQuestion() {
    const q = this.questions[this.walkingIndex];
    if (!q) return;

    document.getElementById('walkQuestionTitle').textContent = q.question;

    const rate = parseFloat(document.getElementById('walkRate').value);
    const pauseSec = parseInt(document.getElementById('walkPause').value);

    const qUtterance = new SpeechSynthesisUtterance(q.question);
    qUtterance.lang = 'de-CH';
    qUtterance.rate = rate;

    qUtterance.onend = () => {
      setTimeout(() => {
        const aUtterance = new SpeechSynthesisUtterance(`Antwort: ${q.correct_answer}`);
        aUtterance.lang = 'de-CH';
        aUtterance.rate = rate;
        aUtterance.onend = () => {
          this.walkingIndex = (this.walkingIndex + 1) % this.questions.length;
          if (this.speechSynth.speaking) this.playWalkingQuestion();
        };
        this.speechSynth.speak(aUtterance);
      }, pauseSec * 1000);
    };

    this.speechSynth.speak(qUtterance);
  }

  nextWalkingQuestion() {
    this.speechSynth.cancel();
    this.walkingIndex = (this.walkingIndex + 1) % this.questions.length;
    this.playWalkingQuestion();
  }

  // --- DASHBOARD ANALYTICS ---
  updateDashboard() {
    const total = this.questions.length;
    const learned = this.progressMap.size;
    const due = Array.from(this.progressMap.values()).filter(p => new Date(p.dueDate) <= new Date()).length;

    document.getElementById('dashTotalQ').textContent = total;
    document.getElementById('dashLearnedQ').textContent = learned;
    document.getElementById('dashDueQ').textContent = due;

    const pct = total > 0 ? Math.round((learned / total) * 100) : 0;
    document.getElementById('dashMasteryPct').textContent = `${pct}%`;
    document.getElementById('dashProgressBar').style.width = `${pct}%`;
  }

  // --- DATA MANAGEMENT ---
  async handleFileImport(evt) {
    const file = evt.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        const questionsToSave = imported.questions || imported;
        await this.db.saveQuestions(questionsToSave);
        this.questions = await this.db.getAllQuestions();
        this.learningQueueStore.state = this.learningQueue;
        this.learningQueue = this.learningQueueStore.reconcile(this.questions, this.progressMap);
        if (!document.getElementById('screen-flashcards').classList.contains('hidden')) {
          this.loadFlashcards();
        }
        alert(`${questionsToSave.length} Fragen erfolgreich importiert!`);
        this.updateDashboard();
      } catch (err) {
        alert('Fehler beim Importieren der JSON-Datei: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  async exportData() {
    const data = {
      questions: this.questions,
      progress: Array.from(this.progressMap.values())
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `einbuergerung-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  async resetProgress() {
    if (confirm('Möchten Sie wirklich den gesamten Lernfortschritt löschen?')) {
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.db.transaction('user_progress', 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.objectStore('user_progress').clear();
        });
        localStorage.removeItem(PROGRESS_STORAGE_KEY);
        this.progressMap.clear();
        this.learningQueueStore.state = this.learningQueue;
        this.learningQueue = this.learningQueueStore.reconcile(this.questions, this.progressMap);
        this.learningQueue = this.learningQueueStore.state;
        this.syncFlashcardQuestions();
        this.updateDashboard();
        alert('Fortschritt zurückgesetzt.');
      } catch (error) {
        alert(`Fortschritt konnte nicht zurückgesetzt werden: ${error.message}`);
      }
    }
  }
}

const app = new App();
window.onload = () => app.init();

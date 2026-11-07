/**
 * Einbürgerung Trainer – Cham & Zug
 * Full Offline Learning Engine with SM-2 Spaced Repetition, Quiz System, & Speech Synthesis.
 */

// IndexedDB Storage Layer
const DB_NAME = 'EinbuergerungChamDB';
const DB_VERSION = 1;

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
    return new Promise((resolve) => {
      const tx = this.db.transaction('user_progress', 'readonly');
      const req = tx.objectStore('user_progress').getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  }

async saveProgress(progressObj) {
  return new Promise((resolve, reject) => {
    const tx = this.db.transaction('user_progress', 'readwrite');

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    tx.objectStore('user_progress').put(progressObj);
  });
}

// App Core Controller
class App {
  constructor() {
    this.db = new LearningDB();
    this.questions = [];
    this.progressMap = new Map();
    this.currentFCIndex = 0;
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

    this.updateDashboard();
    this.registerServiceWorker();
  }


registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('./sw.js', {
    updateViaCache: 'none'
  }).then(reg => {
    reg.update().catch(console.warn);

    let refreshing = false;

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      }
    );
  }).catch(err => {
    console.error('Service Worker Fehler:', err);
  });
}


  showScreen(screenId) {
    document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
    const target = document.getElementById(`screen-${screenId}`);
    if (target) target.classList.remove('hidden');

    if (screenId === 'flashcards') this.loadFlashcards();
    if (screenId === 'interview') this.loadInterviewQuestion();
    if (screenId === 'dashboard') this.updateDashboard();
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
    const q = this.questions[this.currentFCIndex];
    if (!q) return;

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

    this.progressMap.set(q.id, updated);
    await this.db.saveProgress(updated);

    // Reset card flip & show next card
    document.getElementById('cardInner').classList.remove('flipped');
    this.currentFCIndex = (this.currentFCIndex + 1) % this.questions.length;
    setTimeout(() => this.displayCurrentFlashcard(), 300);
  }

  // --- FLASHCARD MODE ---
  loadFlashcards() {
    if (this.questions.length === 0) return;
    this.currentFCIndex = 0;
    this.displayCurrentFlashcard();
  }

  displayCurrentFlashcard() {
    const q = this.questions[this.currentFCIndex];
    if (!q) return;

    document.getElementById('flashcardCounter').textContent = `${this.currentFCIndex + 1} / ${this.questions.length}`;
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
    document.getElementById('quizFeedbackBox').classList.add('hidden');
    document.getElementById('quizProgressText').textContent = `Frage ${this.activeQuiz.currentIndex + 1} von ${this.activeQuiz.questions.length}`;
    document.getElementById('quizScoreText').textContent = `Punkte: ${this.activeQuiz.score}`;
    document.getElementById('quizTopicBadge').textContent = q.topic;
    document.getElementById('quizQuestionText').textContent = q.question;

    const container = document.getElementById('quizOptionsContainer');
    container.innerHTML = '';

    const opts = [...q.options].sort(() => Math.random() - 0.5);
    opts.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'w-full text-left p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 font-medium text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition';
      btn.textContent = opt;
      btn.onclick = () => this.handleQuizAnswer(opt, q.correct_answer, q);
      container.appendChild(btn);
    });
  }

  handleQuizAnswer(selected, correct, q) {
    const isCorrect = selected === correct;
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
      const tx = this.db.db.transaction('user_progress', 'readwrite');
      tx.objectStore('user_progress').clear();
      this.progressMap.clear();
      this.updateDashboard();
      alert('Fortschritt zurückgesetzt.');
    }
  }
}

const app = new App();
window.onload = () => app.init();

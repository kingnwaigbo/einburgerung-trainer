(function (root, factory) {
  const LearningQueue = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = LearningQueue;
  if (root) root.LearningQueue = LearningQueue;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const QUEUE_VERSION = 1;
  const STORAGE_KEY = 'einbuergerungLearningQueueV1';

  class LearningQueue {
    constructor(storage, random = Math.random) {
      this.storage = storage;
      this.random = random;
      this.state = null;
    }

    load(questions, progressMap, now = Date.now()) {
      let savedState = null;
      try {
        const serialized = this.storage.getItem(STORAGE_KEY);
        if (serialized) {
          const parsed = JSON.parse(serialized);
          if (
            parsed.version === QUEUE_VERSION &&
            Array.isArray(parsed.pendingQuestionIds) &&
            Array.isArray(parsed.completedQuestionIds)
          ) {
            savedState = parsed;
          } else {
            console.warn('Gespeicherte Lernwarteschlange hat ein ungültiges Format und wird neu aufgebaut.');
          }
        }
      } catch (error) {
        console.warn(`Lernwarteschlange konnte nicht geladen werden: ${error.message}`);
      }

      this.state = savedState || this.createState(questions, progressMap, now);
      this.reconcile(questions, progressMap, now);
      return this.state;
    }

    startNew(questions, progressMap, now = Date.now()) {
      this.persist(this.createState(questions, progressMap, now), now);
      return this.state;
    }

    completeCurrent(questionId, now = Date.now()) {
      if (!this.state || this.state.pendingQuestionIds[0] !== questionId) return false;

      const nextState = {
        ...this.state,
        pendingQuestionIds: this.state.pendingQuestionIds.slice(1),
        completedQuestionIds: [...this.state.completedQuestionIds]
      };
      if (!nextState.completedQuestionIds.includes(questionId)) {
        nextState.completedQuestionIds.push(questionId);
      }
      nextState.completed = nextState.pendingQuestionIds.length === 0;
      this.persist(nextState, now);
      return true;
    }

    reconcile(questions, progressMap, now = Date.now()) {
      const currentQuestions = this.getFlashcards(questions);
      const questionsById = new Map(currentQuestions.map(question => [question.id, question]));
      const previousState = this.state || this.createState(questions, progressMap, now);
      const lastSavedAt = new Date(previousState.updatedAt || 0).getTime();
      const seen = new Set();
      const pendingQuestionIds = previousState.pendingQuestionIds.filter(id => {
        if (!questionsById.has(id) || seen.has(id)) return false;
        seen.add(id);

        const lastReviewed = new Date(progressMap.get(id)?.lastReviewed || 0).getTime();
        return !(lastReviewed > lastSavedAt);
      });
      const pendingSet = new Set(pendingQuestionIds);
      const completedQuestionIds = previousState.completedQuestionIds.filter(
        id => questionsById.has(id) && !pendingSet.has(id)
      );
      const additions = this.getCandidates(currentQuestions, progressMap, now)
        .filter(question => !pendingSet.has(question.id));
      const dueAdditions = additions
        .filter(question => this.isDue(question, progressMap, now));
      const sortedDueAdditions = this.sortByDueDate(dueAdditions, progressMap);
      const unseenAdditions = this.mixByTopic(
        additions.filter(question => !this.isDue(question, progressMap, now))
      );
      const requeuedIds = new Set([
        ...sortedDueAdditions.map(question => question.id),
        ...unseenAdditions.map(question => question.id)
      ]);

      const nextQuestionId = pendingQuestionIds.shift();

      const nextState = {
        version: QUEUE_VERSION,
        pendingQuestionIds: [
          ...(nextQuestionId ? [nextQuestionId] : []),
          ...sortedDueAdditions.map(question => question.id),
          ...pendingQuestionIds,
          ...unseenAdditions.map(question => question.id)
        ],
        completedQuestionIds: completedQuestionIds.filter(id => !requeuedIds.has(id)),
        completed: false,
        updatedAt: new Date(now).toISOString()
      };
      nextState.completed = nextState.pendingQuestionIds.length === 0;
      this.persist(nextState, now);
      return this.state;
    }

    persist(state = this.state, now = Date.now()) {
      if (!state) return;
      const nextState = {
        ...state,
        pendingQuestionIds: [...state.pendingQuestionIds],
        completedQuestionIds: [...state.completedQuestionIds],
        updatedAt: new Date(now).toISOString()
      };
      this.storage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      this.state = nextState;
    }

    createState(questions, progressMap, now) {
      const queue = this.buildQueue(questions, progressMap, now);
      return {
        version: QUEUE_VERSION,
        pendingQuestionIds: queue.map(question => question.id),
        completedQuestionIds: [],
        completed: queue.length === 0,
        updatedAt: new Date(now).toISOString()
      };
    }

    buildQueue(questions, progressMap, now) {
      const flashcards = this.getFlashcards(questions);
      const due = this.sortByDueDate(
        flashcards.filter(question => this.isDue(question, progressMap, now)),
        progressMap
      );
      const unseen = this.mixByTopic(
        flashcards.filter(question => this.isUnseen(question, progressMap))
      );
      if (due.length || unseen.length) return [...due, ...unseen];

      const futureReviews = flashcards.filter(
        question => this.dueTime(question, progressMap) > now
      );
      const nextReview = this.sortByDueDate(futureReviews, progressMap)[0];
      return nextReview ? [nextReview] : [];
    }

    getCandidates(questions, progressMap, now) {
      const due = this.sortByDueDate(
        questions.filter(question => this.isDue(question, progressMap, now)),
        progressMap
      );
      const unseen = this.mixByTopic(
        questions.filter(question => this.isUnseen(question, progressMap))
      );
      return [...due, ...unseen];
    }

    getFlashcards(questions) {
      return questions.filter(question => question.type === 'flashcard' && question.id);
    }

    isDue(question, progressMap, now) {
      if (!question) return false;
      const dueTime = this.dueTime(question, progressMap);
      return dueTime > 0 && dueTime <= now;
    }

    isUnseen(question, progressMap) {
      const progress = progressMap.get(question.id);
      return !progress || (!progress.lastReviewed && !progress.dueDate);
    }

    dueTime(question, progressMap) {
      const dueDate = progressMap.get(question.id)?.dueDate;
      const dueTime = dueDate ? new Date(dueDate).getTime() : 0;
      return Number.isFinite(dueTime) ? dueTime : 0;
    }

    sortByDueDate(questions, progressMap) {
      const groups = new Map();
      questions.forEach(question => {
        const dueTime = this.dueTime(question, progressMap);
        if (!groups.has(dueTime)) groups.set(dueTime, []);
        groups.get(dueTime).push(question);
      });

      const sortedQuestions = [];
      Array.from(groups.keys()).sort((a, b) => a - b).forEach(dueTime => {
        sortedQuestions.push(...this.shuffle(groups.get(dueTime)));
      });
      return sortedQuestions;
    }

    mixByTopic(questions) {
      const topicGroups = new Map();
      questions.forEach(question => {
        const topic = question.topic || question.subtopic || 'other';
        if (!topicGroups.has(topic)) topicGroups.set(topic, []);
        topicGroups.get(topic).push(question);
      });

      const topics = this.shuffle(Array.from(topicGroups.keys()));
      topics.forEach(topic => {
        topicGroups.set(topic, this.shuffle(topicGroups.get(topic)));
      });

      const mixed = [];
      while (topics.some(topic => topicGroups.get(topic).length > 0)) {
        topics.forEach(topic => {
          const question = topicGroups.get(topic).shift();
          if (question) mixed.push(question);
        });
      }
      return mixed;
    }

    shuffle(items) {
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const randomValue = Math.max(0, Math.min(0.999999999, this.random()));
        const swapIndex = Math.floor(randomValue * (i + 1));
        [shuffled[i], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[i]];
      }
      return shuffled;
    }
  }

  return LearningQueue;
});

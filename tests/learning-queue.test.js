const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const LearningQueue = require('../learning-queue.js');

const NOW = Date.parse('2030-01-15T12:00:00.000Z');

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) || null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

function makeQuestions(entries) {
  return entries.map(([id, topic]) => ({
    id,
    topic,
    type: 'flashcard',
    question: `Question ${id}`
  }));
}

function dueProgress(id, dueDate) {
  return [id, {
    id,
    repetitions: 1,
    interval: 1,
    easinessFactor: 2.5,
    dueDate: new Date(dueDate).toISOString(),
    lastReviewed: new Date(dueDate - 86400000).toISOString()
  }];
}

test('prioritizes due reviews and interleaves unseen topics', () => {
  const questions = makeQuestions([
    ['due-later', 'Due'],
    ['topic-a-1', 'A'],
    ['due-first', 'Due'],
    ['topic-b-1', 'B'],
    ['topic-a-2', 'A'],
    ['topic-c-1', 'C'],
    ['topic-b-2', 'B'],
    ['topic-c-2', 'C']
  ]);
  const progress = new Map([
    dueProgress('due-later', NOW - 1000),
    dueProgress('due-first', NOW - 10000)
  ]);
  const queue = new LearningQueue(new MemoryStorage(), () => 0.37);
  const state = queue.startNew(questions, progress, NOW);

  assert.deepEqual(state.pendingQuestionIds.slice(0, 2), ['due-first', 'due-later']);
  const unseen = state.pendingQuestionIds.slice(2).map(id => questions.find(q => q.id === id).topic);
  assert.notEqual(unseen[0], unseen[1]);
  assert.notEqual(unseen[1], unseen[2]);
  assert.equal(new Set(state.pendingQuestionIds).size, questions.length);
});

test('reopening resumes at the exact next card after a saved rating', () => {
  const storage = new MemoryStorage();
  const questions = makeQuestions([['one', 'A'], ['two', 'B'], ['three', 'C']]);
  const progress = new Map();
  const firstSession = new LearningQueue(storage, () => 0.41);
  const initialState = firstSession.startNew(questions, progress, NOW);
  const ratedId = initialState.pendingQuestionIds[0];
  const nextId = initialState.pendingQuestionIds[1];

  progress.set(ratedId, {
    id: ratedId,
    repetitions: 1,
    interval: 1,
    easinessFactor: 2.5,
    dueDate: new Date(NOW + 86400000).toISOString(),
    lastReviewed: new Date(NOW + 1).toISOString()
  });
  firstSession.completeCurrent(ratedId, NOW + 2);

  const reopened = new LearningQueue(storage, () => 0.9);
  const restored = reopened.load(questions, progress, NOW + 3);
  assert.equal(restored.pendingQuestionIds[0], nextId);
  assert.equal(restored.pendingQuestionIds.includes(ratedId), false);
});

test('reconciling on screen navigation does not reset queue order or position', () => {
  const storage = new MemoryStorage();
  const questions = makeQuestions([
    ['due-one', 'Due'],
    ['due-two', 'Due'],
    ['due-three', 'Due'],
    ['unseen', 'Unseen']
  ]);
  const progress = new Map([
    dueProgress('due-one', NOW - 1000),
    dueProgress('due-two', NOW - 1000),
    dueProgress('due-three', NOW - 1000)
  ]);
  let randomValue = 0;
  const queue = new LearningQueue(storage, () => randomValue);
  const initial = queue.load(questions, progress, NOW);
  const expectedOrder = [...initial.pendingQuestionIds];
  randomValue = 0.99;

  queue.reconcile(questions, progress, NOW + 1000);
  const afterLeavingAndReturning = queue.reconcile(questions, progress, NOW + 2000);

  assert.deepEqual(afterLeavingAndReturning.pendingQuestionIds, expectedOrder);
});

test('marks a finished queue complete and starts a new session only on request', () => {
  const storage = new MemoryStorage();
  const questions = makeQuestions([['one', 'A'], ['two', 'B']]);
  const progress = new Map();
  const queue = new LearningQueue(storage, () => 0.6);
  const state = queue.startNew(questions, progress, NOW);

  for (const id of [...state.pendingQuestionIds]) {
    progress.set(id, {
      id,
      repetitions: 1,
      interval: 1,
      easinessFactor: 2.5,
      dueDate: new Date(NOW + 86400000).toISOString(),
      lastReviewed: new Date(NOW + 1).toISOString()
    });
    queue.completeCurrent(id, NOW + 2);
  }

  assert.equal(queue.state.completed, true);
  assert.deepEqual(queue.state.pendingQuestionIds, []);
  assert.equal(queue.load(questions, progress, NOW + 3).completed, true);

  const nextSession = queue.startNew(questions, progress, NOW + 4);
  assert.equal(nextSession.completed, false);
  assert.equal(nextSession.pendingQuestionIds.length, 1);
});

test('adds new cards and drops removed cards without losing the next existing card', () => {
  const storage = new MemoryStorage();
  const queue = new LearningQueue(storage, () => 0.34);
  const original = makeQuestions([['one', 'A'], ['two', 'B']]);
  const initial = queue.startNew(original, new Map(), NOW);
  const retainedNextId = initial.pendingQuestionIds[0];
  const changed = makeQuestions([
    [retainedNextId, 'A'],
    ['new-card', 'C']
  ]);

  const reconciled = queue.reconcile(changed, new Map(), NOW + 1);
  assert.deepEqual(reconciled.pendingQuestionIds, [retainedNextId, 'new-card']);
});

test('builds and restores the queue offline using browser storage only', () => {
  const storage = new MemoryStorage();
  storage.setItem('einbuergerungProgress', '[{"id":"existing-progress"}]');
  const questions = makeQuestions([['one', 'A'], ['two', 'B']]);
  const queue = new LearningQueue(storage, () => 0.5);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const state = queue.startNew(questions, new Map(), NOW);
    const offlineQueue = new LearningQueue(storage, () => 0.1);
    assert.deepEqual(
      offlineQueue.load(questions, new Map(), NOW + 1).pendingQuestionIds,
      state.pendingQuestionIds
    );
    assert.equal(storage.getItem('einbuergerungProgress'), '[{"id":"existing-progress"}]');
    assert.match(
      fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'),
      /'\.\/learning-queue\.js'/
    );
    assert.match(
      fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'),
      /<script src="learning-queue\.js"><\/script>/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

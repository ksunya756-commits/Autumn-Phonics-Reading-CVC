(() => {
  'use strict';

  const STORAGE_KEY = 'autumn-sound-garden-v1';
  const VOWELS = new Set(['a', 'e', 'i', 'o']);
  const PHONEMES = {
    a: '/æ/', b: '/b/', c: '/k/', d: '/d/', e: '/e/', f: '/f/', g: '/ɡ/', h: '/h/',
    i: '/ɪ/', j: '/dʒ/', k: '/k/', l: '/l/', m: '/m/', n: '/n/', o: '/ɒ/', p: '/p/', r: '/ɹ/',
  };
  const TEACHER_LETTERS = Object.keys(PHONEMES);
  const speakerSvg = '<svg class="speaker-mark" aria-hidden="true" viewBox="0 0 24 24"><path d="M11 5 6.5 9H3v6h3.5l4.5 4V5Z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/></svg>';

  const elements = {
    screens: [...document.querySelectorAll('.screen')],
    start: document.querySelector('#start-screen'), game: document.querySelector('#game-screen'), complete: document.querySelector('#complete-screen'),
    listGrid: document.querySelector('#list-grid'), startButton: document.querySelector('#start-button'), startStatus: document.querySelector('#start-status'),
    gameTitle: document.querySelector('#game-title'), wordCounter: document.querySelector('#word-counter'), letterRow: document.querySelector('#letter-row'),
    revealPrompt: document.querySelector('#reveal-prompt'), revealedWord: document.querySelector('#revealed-word'), readingFeedback: document.querySelector('#reading-feedback'), soundOut: document.querySelector('#sound-out-button'),
    read: document.querySelector('#read-button'), next: document.querySelector('#next-button'), back: document.querySelector('#back-button'), home: document.querySelector('#home-button'),
    effects: document.querySelector('#effects-button'), fullscreen: document.querySelector('#fullscreen-button'), gameStatus: document.querySelector('#game-status'),
    retryAudio: document.querySelector('#retry-audio-button'), celebration: document.querySelector('#celebration'), again: document.querySelector('#again-button'),
    choose: document.querySelector('#choose-button'), ambient: document.querySelector('.ambient'), teacherButton: document.querySelector('#teacher-button'),
    teacherDialog: document.querySelector('#teacher-dialog'), closeTeacher: document.querySelector('#close-teacher'), teacherSounds: document.querySelector('#teacher-sounds'),
    teacherStatus: document.querySelector('#teacher-status'), volume: document.querySelector('#volume-range'), volumeOutput: document.querySelector('#volume-output'),
    gap: document.querySelector('#gap-range'), gapOutput: document.querySelector('#gap-output'),
  };

  const audio = new PhonicsAudio('assets/audio/phonemes/manifest.json');
  let state = loadState();
  let selectedListId = state.selectedListId || 'list-1';
  let selectedOrder = state.order || 'in-order';
  let session = validSession(state.session) ? state.session : null;
  let listened = [false, false, false];
  let readRevealed = false;
  let audioReady = false;
  let audioLoadGeneration = 0;
  let recognitionGeneration = 0;
  let activeRecognition = null;

  function defaultState() {
    return { selectedListId: 'list-1', order: 'in-order', progress: Object.fromEntries(WORD_LISTS.map((list) => [list.id, []])), session: null, volume: 0.9, gap: 100, effects: true };
  }

  function loadState() {
    const fallback = defaultState();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== 'object') return fallback;
      return { ...fallback, ...saved, progress: { ...fallback.progress, ...(saved.progress || {}) } };
    } catch (_) { return fallback; }
  }

  function saveState() {
    state.selectedListId = selectedListId;
    state.order = selectedOrder;
    state.session = session;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (_) { setStatus(elements.gameStatus, 'Progress cannot be saved in this browser.', true); }
  }

  function validSession(candidate) {
    if (!candidate || !Array.isArray(candidate.sequence)) return false;
    const list = WORD_LISTS.find((item) => item.id === candidate.listId);
    return Boolean(list && candidate.sequence.length === 8 && candidate.sequence.every((word) => list.words.includes(word)) && new Set(candidate.sequence).size === 8 && Number.isInteger(candidate.index) && candidate.index >= 0 && candidate.index < 8);
  }

  function currentList() { return WORD_LISTS.find((list) => list.id === session?.listId) || WORD_LISTS[0]; }
  function currentWord() { return session?.sequence[session.index] || currentList().words[0]; }
  function completedFor(listId) {
    const allowed = new Set(WORD_LISTS.find((list) => list.id === listId)?.words || []);
    return new Set((state.progress[listId] || []).filter((word) => allowed.has(word)));
  }
  function setStatus(element, text = '', isError = false) { element.textContent = text; element.classList.toggle('error', isError); }

  function showScreen(target) {
    audio.cancel(); stopRecognition(); clearPlaying();
    elements.screens.forEach((screen) => { const active = screen === target; screen.hidden = !active; screen.classList.toggle('active', active); });
  }

  function renderListGrid() {
    elements.listGrid.replaceChildren();
    WORD_LISTS.forEach((list) => {
      const count = completedFor(list.id).size;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `list-card${selectedListId === list.id ? ' selected' : ''}`;
      button.dataset.listId = list.id;
      button.setAttribute('aria-pressed', selectedListId === list.id ? 'true' : 'false');
      button.innerHTML = `<span class="list-name">${list.title}</span><span class="list-progress">${count} / 8</span><span class="list-progress-track" aria-hidden="true"><span style="width:${count * 12.5}%"></span></span>`;
      button.addEventListener('click', () => { selectedListId = list.id; saveState(); renderListGrid(); });
      elements.listGrid.append(button);
    });
  }

  function setOrder(order) {
    selectedOrder = order;
    document.querySelectorAll('.order-option').forEach((button) => { const active = button.dataset.order === order; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    saveState();
  }

  function shuffle(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) { const swapIndex = Math.floor(Math.random() * (index + 1)); [result[index], result[swapIndex]] = [result[swapIndex], result[index]]; }
    return result;
  }

  async function startNewSession({ resetProgress = false } = {}) {
    const list = WORD_LISTS.find((item) => item.id === selectedListId) || WORD_LISTS[0];
    if (resetProgress) state.progress[list.id] = [];
    try { await audio.unlock(); }
    catch (error) { setStatus(elements.startStatus, error.message, true); return; }
    elements.startButton.disabled = true;
    setStatus(elements.startStatus, 'Preparing the sounds…');
    try {
      await loadListAudio(list);
      session = { listId: list.id, order: selectedOrder, sequence: selectedOrder === 'mix' ? shuffle(list.words) : [...list.words], index: 0 };
      saveState(); showGame();
    } catch (error) { setStatus(elements.startStatus, `${error.message} Check the supplied audio files and try again.`, true); }
    finally { elements.startButton.disabled = false; }
  }

  function keysForList(list) { return [...new Set(list.words.flatMap((word) => [...word].map((letter) => LETTER_TO_AUDIO_KEY[letter])))]; }

  async function loadListAudio(list = currentList()) {
    const generation = ++audioLoadGeneration;
    audioReady = false; updateAudioAvailability();
    await audio.loadKeys(keysForList(list));
    if (generation !== audioLoadGeneration) return false;
    audioReady = true; updateAudioAvailability(); return true;
  }

  function updateAudioAvailability() {
    elements.soundOut.disabled = !audioReady;
    elements.letterRow.querySelectorAll('.letter-tile').forEach((tile) => { tile.disabled = !audioReady; });
  }

  function showGame() {
    showScreen(elements.game); renderWord();
    if (!audioReady) { setStatus(elements.gameStatus, 'Preparing the sounds…'); loadListAudio().then(() => setStatus(elements.gameStatus, '')).catch(handleAudioError); }
  }

  function renderWord() {
    audio.cancel(); stopRecognition(); listened = [false, false, false]; readRevealed = false;
    elements.gameTitle.textContent = currentList().title;
    elements.wordCounter.textContent = `${session.index + 1} / 8`;
    elements.revealPrompt.innerHTML = '&nbsp;'; elements.revealedWord.innerHTML = '&nbsp;'; elements.revealedWord.setAttribute('aria-hidden', 'true');
    elements.readingFeedback.hidden = true;
    elements.read.disabled = false; elements.read.title = 'Read the word into the microphone';
    elements.next.disabled = true; elements.next.title = 'Read the word aloud first';
    elements.back.disabled = session.index === 0; elements.retryAudio.hidden = true;
    setStatus(elements.gameStatus, audioReady ? '' : 'Preparing the sounds…');
    elements.letterRow.replaceChildren();
    [...currentWord()].forEach((letter, index) => {
      const vowel = VOWELS.has(letter);
      const wrap = document.createElement('div'); wrap.className = `letter-wrap${vowel ? ' vowel' : ''}`; wrap.dataset.index = String(index);
      const tile = document.createElement('button'); tile.type = 'button'; tile.className = `letter-tile${vowel ? ' vowel' : ''}`; tile.disabled = !audioReady;
      tile.setAttribute('aria-label', `Play sound for letter ${letter}, sound ${index + 1} of 3`);
      tile.innerHTML = `<span class="letter-glyph">${letter}</span>${speakerSvg}`; tile.addEventListener('click', () => playPosition(index));
      const mark = document.createElement('span'); mark.className = 'heard-mark'; mark.setAttribute('aria-hidden', 'true');
      wrap.append(tile, mark); elements.letterRow.append(wrap);
    });
  }

  function positionElements(index) { const wrap = elements.letterRow.querySelector(`[data-index="${index}"]`); return { wrap, tile: wrap?.querySelector('.letter-tile') }; }
  function clearPlaying() { document.querySelectorAll('.playing').forEach((item) => item.classList.remove('playing')); }

  function markHeard(index) {
    listened[index] = true; positionElements(index).wrap?.classList.add('heard');
    if (listened.every(Boolean)) setStatus(elements.gameStatus, 'All three sounds heard. Now read the word aloud.');
  }

  async function playPosition(index) {
    if (!audioReady) return;
    stopRecognition();
    clearPlaying();
    const key = LETTER_TO_AUDIO_KEY[currentWord()[index]]; const { tile } = positionElements(index); setStatus(elements.gameStatus, '');
    try { await audio.playSingle(key, { onStart: () => tile?.classList.add('playing'), onComplete: () => markHeard(index), onStop: () => tile?.classList.remove('playing') }); }
    catch (error) { tile?.classList.remove('playing'); handleAudioError(error); }
  }

  async function soundItOut() {
    if (!audioReady) return;
    stopRecognition();
    clearPlaying();
    const items = [...currentWord()].map((letter, index) => ({ letter, index, key: LETTER_TO_AUDIO_KEY[letter] }));
    setStatus(elements.gameStatus, 'Listen to each sound…');
    try {
      const completed = await audio.playSequence(items, state.gap, {
        onStart: (item) => positionElements(item.index).tile?.classList.add('playing'), onComplete: (item) => markHeard(item.index),
        onStop: (item) => positionElements(item.index).tile?.classList.remove('playing'), onSequenceComplete: () => setStatus(elements.gameStatus, 'All three sounds heard. Now read the word aloud.'),
      });
      if (!completed) clearPlaying();
    } catch (error) { clearPlaying(); handleAudioError(error); }
  }

  function setMicrophoneState(listening) {
    elements.read.classList.toggle('listening', listening);
    elements.read.setAttribute('aria-pressed', String(listening));
    const label = elements.read.querySelector('span');
    if (label) label.textContent = listening ? 'Listening…' : 'Read aloud';
  }

  function stopRecognition() {
    recognitionGeneration += 1;
    const recognition = activeRecognition;
    activeRecognition = null;
    if (recognition) {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onnomatch = null;
      recognition.onerror = null;
      recognition.onend = null;
      try { recognition.abort(); } catch (_) { /* already stopped */ }
    }
    setMicrophoneState(false);
  }

  function transcriptMatchesWord(transcript, word) {
    const cleaned = String(transcript).toLowerCase().replace(/[^a-z\s]/g, ' ').trim().replace(/\s+/g, ' ');
    return cleaned.split(' ').includes(word);
  }

  function showReadingSuccess(word) {
    readRevealed = true;
    elements.revealPrompt.innerHTML = '&nbsp;';
    elements.revealedWord.textContent = word;
    elements.revealedWord.setAttribute('aria-hidden', 'false');
    elements.readingFeedback.hidden = false;
    elements.next.disabled = false;
    elements.next.title = '';
    setStatus(elements.gameStatus, 'Great reading! You can go to the next word.');
    elements.celebration.classList.remove('active');
    void elements.celebration.offsetWidth;
    if (state.effects) elements.celebration.classList.add('active');
  }

  function startReadingCheck() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setStatus(elements.gameStatus, 'Voice checking is not available in this browser. Please use Chrome or Edge.', true);
      return;
    }

    audio.cancel();
    clearPlaying();
    stopRecognition();
    const token = recognitionGeneration;
    const word = currentWord();
    const sessionIndex = session?.index;
    const recognition = new Recognition();
    let handled = false;
    activeRecognition = recognition;
    recognition.lang = 'en-GB';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 5;

    const isCurrent = () => token === recognitionGeneration && session?.index === sessionIndex && currentWord() === word;
    const finishAttempt = () => {
      if (!isCurrent()) return;
      activeRecognition = null;
      setMicrophoneState(false);
      elements.read.disabled = false;
    };
    const tryAgain = (message) => {
      if (!isCurrent()) return;
      readRevealed = false;
      elements.readingFeedback.hidden = true;
      elements.revealPrompt.textContent = 'Try once more.';
      elements.revealedWord.innerHTML = '&nbsp;';
      elements.revealedWord.setAttribute('aria-hidden', 'true');
      elements.next.disabled = true;
      setStatus(elements.gameStatus, message, true);
    };

    recognition.onstart = () => {
      if (!isCurrent()) return;
      readRevealed = false;
      elements.read.disabled = true;
      elements.next.disabled = true;
      elements.next.title = 'Read the word aloud first';
      setMicrophoneState(true);
      elements.readingFeedback.hidden = true;
      elements.revealPrompt.textContent = 'Say the word.';
      elements.revealedWord.innerHTML = '&nbsp;';
      elements.revealedWord.setAttribute('aria-hidden', 'true');
      setStatus(elements.gameStatus, 'Listening…');
    };
    recognition.onresult = (event) => {
      if (!isCurrent()) return;
      handled = true;
      const alternatives = [];
      for (let resultIndex = 0; resultIndex < event.results.length; resultIndex += 1) {
        for (let alternativeIndex = 0; alternativeIndex < event.results[resultIndex].length; alternativeIndex += 1) {
          alternatives.push(event.results[resultIndex][alternativeIndex].transcript);
        }
      }
      if (alternatives.some((transcript) => transcriptMatchesWord(transcript, word))) showReadingSuccess(word);
      else tryAgain('I heard a different word. Listen to the sounds and try again.');
    };
    recognition.onnomatch = () => {
      handled = true;
      tryAgain('I could not match that word. Please try again.');
    };
    recognition.onerror = (event) => {
      if (!isCurrent()) return;
      handled = true;
      const messages = {
        'not-allowed': 'Microphone permission was not granted. Allow it in the browser settings and try again.',
        'service-not-allowed': 'Voice checking is blocked by the browser settings.',
        'audio-capture': 'No working microphone was found.',
        'no-speech': 'I did not hear a word. Please try again.',
        network: 'Voice checking needs an internet connection in this browser.',
      };
      tryAgain(messages[event.error] || 'The voice check could not start. Please try again.');
    };
    recognition.onend = () => {
      if (!isCurrent()) return;
      if (!handled) tryAgain('I did not hear a word. Please try again.');
      finishAttempt();
    };

    try {
      recognition.start();
    } catch (_) {
      handled = true;
      tryAgain('The microphone is already busy. Please try again.');
      finishAttempt();
    }
  }

  function nextWord() {
    if (!readRevealed) return;
    const completed = completedFor(session.listId); completed.add(currentWord()); state.progress[session.listId] = [...completed]; renderListGrid();
    if (session.index === session.sequence.length - 1) { session = null; saveState(); showScreen(elements.complete); return; }
    session.index += 1; saveState(); renderWord();
  }

  function previousWord() { if (!session || session.index === 0) return; session.index -= 1; saveState(); renderWord(); }

  function goHome() {
    audioLoadGeneration += 1; audioReady = false; session = null; saveState(); renderListGrid(); setStatus(elements.startStatus, ''); showScreen(elements.start);
  }

  function handleAudioError(error) {
    audio.cancel(); audioReady = false; updateAudioAvailability();
    setStatus(elements.gameStatus, `${error.message || 'A sound could not be played.'} No silent substitute was used.`, true); elements.retryAudio.hidden = false;
  }

  async function retryAudio() {
    elements.retryAudio.hidden = true; setStatus(elements.gameStatus, 'Preparing the sounds…');
    try { await audio.unlock(); await loadListAudio(); setStatus(elements.gameStatus, 'Sounds are ready.'); }
    catch (error) { handleAudioError(error); }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else setStatus(elements.gameStatus, 'Full screen is not available in this browser.');
    } catch (_) { setStatus(elements.gameStatus, 'Full screen could not be opened.'); }
  }

  function renderTeacherSounds() {
    elements.teacherSounds.replaceChildren();
    TEACHER_LETTERS.forEach((letter) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'sound-check'; button.dataset.letter = letter;
      button.setAttribute('aria-label', `Listen to ${letter}, ${PHONEMES[letter]}`); button.innerHTML = `<span class="sound-letter">${letter}</span><span class="phoneme">${PHONEMES[letter]}</span>`;
      button.addEventListener('click', async () => {
        clearPlaying(); setStatus(elements.teacherStatus, `Loading ${letter}…`);
        try {
          await audio.playSingle(LETTER_TO_AUDIO_KEY[letter], {
            onStart: () => { button.classList.add('playing'); setStatus(elements.teacherStatus, `Playing ${letter} ${PHONEMES[letter]}`); },
            onStop: () => button.classList.remove('playing'), onComplete: () => setStatus(elements.teacherStatus, ''),
          });
        } catch (error) { button.classList.remove('playing'); setStatus(elements.teacherStatus, `${error.message} No substitute sound was used.`, true); }
      });
      elements.teacherSounds.append(button);
    });
  }

  function openTeacher() { audio.cancel(); clearPlaying(); setStatus(elements.teacherStatus, ''); elements.teacherDialog.showModal(); }
  function closeTeacher() { audio.cancel(); clearPlaying(); elements.teacherDialog.close(); }

  function initialiseSettings() {
    audio.setVolume(state.volume); elements.volume.value = String(Math.round(state.volume * 100)); elements.volumeOutput.value = `${Math.round(state.volume * 100)}%`;
    elements.gap.value = String(state.gap); elements.gapOutput.value = `${state.gap} ms`;
    elements.ambient.classList.toggle('muted', !state.effects); elements.effects.setAttribute('aria-pressed', String(state.effects)); elements.effects.setAttribute('aria-label', `Sound effects ${state.effects ? 'on' : 'off'}`);
  }

  function bindEvents() {
    document.querySelectorAll('.order-option').forEach((button) => button.addEventListener('click', () => setOrder(button.dataset.order)));
    elements.startButton.addEventListener('click', () => startNewSession()); elements.home.addEventListener('click', goHome); elements.soundOut.addEventListener('click', soundItOut);
    elements.read.addEventListener('click', startReadingCheck); elements.next.addEventListener('click', nextWord); elements.back.addEventListener('click', previousWord);
    elements.retryAudio.addEventListener('click', retryAudio); elements.fullscreen.addEventListener('click', toggleFullscreen);
    elements.again.addEventListener('click', () => { selectedListId = state.selectedListId; startNewSession({ resetProgress: true }); }); elements.choose.addEventListener('click', goHome);
    elements.effects.addEventListener('click', () => {
      state.effects = !state.effects; elements.ambient.classList.toggle('muted', !state.effects); elements.effects.setAttribute('aria-pressed', String(state.effects));
      elements.effects.setAttribute('aria-label', `Sound effects ${state.effects ? 'on' : 'off'}`); saveState();
    });
    elements.teacherButton.addEventListener('click', openTeacher); elements.closeTeacher.addEventListener('click', closeTeacher);
    elements.teacherDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeTeacher(); });
    elements.teacherDialog.addEventListener('click', (event) => { if (event.target === elements.teacherDialog) closeTeacher(); });
    elements.volume.addEventListener('input', () => { state.volume = Number(elements.volume.value) / 100; audio.setVolume(state.volume); elements.volumeOutput.value = `${elements.volume.value}%`; saveState(); });
    elements.gap.addEventListener('input', () => { state.gap = Number(elements.gap.value); elements.gapOutput.value = `${state.gap} ms`; saveState(); });
    document.addEventListener('keydown', (event) => {
      if (elements.teacherDialog.open || elements.game.hidden) return;
      const tag = event.target?.tagName;
      if (['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A'].includes(tag) || event.target?.isContentEditable) return;
      if (['1', '2', '3'].includes(event.key)) { event.preventDefault(); elements.letterRow.querySelectorAll('.letter-tile')[Number(event.key) - 1]?.click(); }
      else if (event.key === 'Enter') { event.preventDefault(); if (!elements.next.disabled) elements.next.click(); else if (!elements.read.disabled) elements.read.click(); }
    });
  }

  function init() {
    state.volume = Number.isFinite(Number(state.volume)) ? Math.max(0, Math.min(1, Number(state.volume))) : 0.9;
    state.gap = Number.isFinite(Number(state.gap)) ? Math.max(80, Math.min(200, Number(state.gap))) : 100;
    state.effects = state.effects !== false;
    renderListGrid(); setOrder(selectedOrder); renderTeacherSounds(); initialiseSettings(); bindEvents();
    if (session) { selectedListId = session.listId; selectedOrder = session.order; showGame(); } else showScreen(elements.start);
    window.__AUTUMN_SOUND_GARDEN__ = { getState: () => ({ state: JSON.parse(JSON.stringify(state)), session: session ? { ...session } : null, listened: [...listened], readRevealed, audioReady }), lists: WORD_LISTS };
  }

  init();
})();


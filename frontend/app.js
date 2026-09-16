// PDF Audio Reader - State & Engine
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // State
  const state = {
    currentDoc: null,
    currentSectionIndex: 0,
    isPlaying: false,
    isLoadingAudio: false,
    isAutoAdvancing: false,
    pendingAutoPlay: false,
    playbackSpeed: 1.0,
    volumeBoost: 1.0, // 1.0x, 1.5x, 2.0x, 2.5x
    selectedVoice: localStorage.getItem('selected_voice') || 'en-US-ChristopherNeural',
    voices: [],
    audioDuration: 0,
    currentTime: 0,
  };

  const SPEED_STEPS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
  const VOLUME_BOOST_STEPS = [1.0, 1.5, 2.0, 2.5];

  // In-Memory & Device Cache for Instant Gapless Playback
  const audioBlobCache = new Map(); // key: "docId_sectionId_voice" -> blobUrl
  const prefetchingKeys = new Set();

  // Web Audio Context for Outdoor/Lawnmower Volume Amplification & Compression
  let audioCtx = null;
  let gainNode = null;
  let compressorNode = null;
  let isWebAudioInitialized = false;

  function initWebAudio() {
    if (isWebAudioInitialized) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      audioCtx = new AudioContextClass();
      const source = audioCtx.createMediaElementSource(audio);

      // Speech clarity dynamics compressor
      compressorNode = audioCtx.createDynamicsCompressor();
      compressorNode.threshold.setValueAtTime(-24, audioCtx.currentTime);
      compressorNode.knee.setValueAtTime(25, audioCtx.currentTime);
      compressorNode.ratio.setValueAtTime(10, audioCtx.currentTime);
      compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
      compressorNode.release.setValueAtTime(0.2, audioCtx.currentTime);

      // Volume amplifier gain node
      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(state.volumeBoost, audioCtx.currentTime);

      // Connect pipeline: source -> compressor -> gain -> speakers
      source.connect(compressorNode);
      compressorNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      isWebAudioInitialized = true;
    } catch (e) {
      console.warn('Web Audio initialization fallback:', e);
    }
  }

  function applyVolumeBoost(multiplier) {
    state.volumeBoost = multiplier;
    if (audioCtx && gainNode) {
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      gainNode.gain.setValueAtTime(multiplier, audioCtx.currentTime);
    }
    const label = document.getElementById('volume-boost-label');
    if (label) label.textContent = `${multiplier}x`;

    const navLabel = document.getElementById('nav-vol-label');
    if (navLabel) navLabel.textContent = `Vol: ${multiplier}x`;

    const readerLabel = document.getElementById('reader-vol-label');
    if (readerLabel) readerLabel.textContent = `${multiplier}x`;

    document.querySelectorAll('.vol-opt-btn').forEach(btn => {
      const v = parseFloat(btn.getAttribute('data-vol'));
      btn.classList.toggle('active', v === multiplier);
    });
  }

  // DOM Elements
  const audio = document.getElementById('main-audio-element');
  const btnPlayPause = document.getElementById('btn-play-pause');
  const playIcon = document.getElementById('play-icon');
  const btnSkipBack = document.getElementById('btn-skip-back');
  const btnSkipForward = document.getElementById('btn-skip-forward');
  const btnPrevChapter = document.getElementById('btn-prev-chapter');
  const btnNextChapter = document.getElementById('btn-next-chapter');
  const btnSpeedToggle = document.getElementById('btn-speed-toggle');
  const btnVolumeBoost = document.getElementById('btn-volume-boost');
  const btnVoiceQuick = document.getElementById('btn-voice-quick');
  const currentVoiceName = document.getElementById('current-voice-name');
  const audioScrubber = document.getElementById('audio-scrubber');
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');

  const playerTrackName = document.getElementById('player-track-name');
  const playerTrackSub = document.getElementById('player-track-sub');

  // Reader elements
  const docCard = document.getElementById('doc-card');
  const chaptersCard = document.getElementById('chapters-card');
  const emptyState = document.getElementById('empty-state');
  const readerView = document.getElementById('reader-view');
  const docTitle = document.getElementById('doc-title');
  const docPages = document.getElementById('doc-pages');
  const docDuration = document.getElementById('doc-duration');
  const chapterCountBadge = document.getElementById('chapter-count-badge');
  const chaptersList = document.getElementById('chapters-list');
  const readingSectionNumber = document.getElementById('reading-section-number');
  const readingSectionTitle = document.getElementById('reading-section-title');
  const readerParagraphs = document.getElementById('reader-paragraphs');
  const btnReadAloudSec = document.getElementById('btn-read-aloud-sec');

  // Pre-cache elements
  const btnPrecacheAll = document.getElementById('btn-precache-all');
  const cachePercentageBadge = document.getElementById('cache-percentage-badge');
  let cachePollInterval = null;

  // Modals
  const uploadModal = document.getElementById('upload-modal');
  const settingsModal = document.getElementById('settings-modal');
  const btnOpenUpload = document.getElementById('btn-open-upload');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnLoadSample = document.getElementById('btn-load-sample');
  const emptyUploadBtn = document.getElementById('empty-upload-btn');
  const emptySampleBtn = document.getElementById('empty-sample-btn');
  const closeUploadModal = document.getElementById('close-upload-modal');
  const closeSettingsModal = document.getElementById('close-settings-modal');
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const selectedFileName = document.getElementById('selected-file-name');
  const btnStartUpload = document.getElementById('btn-start-upload');
  const voiceSelect = document.getElementById('voice-select');
  const btnSaveSettings = document.getElementById('btn-save-settings');

  // Add Content Tabs & Inputs
  const tabBtnPdf = document.getElementById('tab-btn-pdf');
  const tabBtnWeb = document.getElementById('tab-btn-web');
  const tabBtnText = document.getElementById('tab-btn-text');
  const panePdf = document.getElementById('pane-pdf');
  const paneWeb = document.getElementById('pane-web');
  const paneText = document.getElementById('pane-text');

  const playlistTitleInput = document.getElementById('playlist-title-input');
  const playlistUrlsInput = document.getElementById('playlist-urls-input');
  const webStatusMsg = document.getElementById('web-status-msg');
  const btnStartPlaylist = document.getElementById('btn-start-playlist');

  const rawtextTitleInput = document.getElementById('rawtext-title-input');
  const rawtextBodyInput = document.getElementById('rawtext-body-input');
  const rawtextStatusMsg = document.getElementById('rawtext-status-msg');
  const btnStartRawtext = document.getElementById('btn-start-rawtext');

  const emptyWebBtn = document.getElementById('empty-web-btn');

  let selectedUploadFile = null;
  let isDraggingScrubber = false;

  // Initialize
  async function init() {
    setupEventListeners();
    setupMediaSession();
    await loadVoices();
    await loadLastSessionOrDocuments();
  }

  // Format seconds to mm:ss or hh:mm:ss
  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);

    const sStr = s < 10 ? `0${s}` : `${s}`;
    if (h > 0) {
      const mStr = m < 10 ? `0${m}` : `${m}`;
      return `${h}:${mStr}:${sStr}`;
    }
    return `${m}:${sStr}`;
  }

  // Load Voices
  async function loadVoices() {
    try {
      const res = await fetch('/api/voices');
      const data = await res.json();
      state.voices = data.voices || [];

      voiceSelect.innerHTML = '';
      state.voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.provider ? `${v.name} (${v.provider.toUpperCase()})` : v.name;
        if (v.id === state.selectedVoice) {
          opt.selected = true;
        }
        voiceSelect.appendChild(opt);
      });
      updateVoiceButtonLabel();
    } catch (e) {
      console.warn('Could not load voices from API:', e);
    }
  }

  function updateVoiceButtonLabel() {
    const active = state.voices.find(v => v.id === state.selectedVoice);
    if (active) {
      currentVoiceName.textContent = active.name.split(' ')[0];
    } else {
      currentVoiceName.textContent = 'Voice';
    }
  }

  // Setup MediaSession for phone lock screen & background controls
  function setupMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => playAudio());
      navigator.mediaSession.setActionHandler('pause', () => pauseAudio());
      navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15));
      navigator.mediaSession.setActionHandler('seekforward', () => skip(15));
      navigator.mediaSession.setActionHandler('previoustrack', () => prevChapter());
      navigator.mediaSession.setActionHandler('nexttrack', () => nextChapter());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime && audio.duration) {
          audio.currentTime = details.seekTime;
        }
      });
    }
  }

  function updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || !state.currentDoc) return;
    const sec = state.currentDoc.sections[state.currentSectionIndex];
    if (!sec) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: sec.title || `Section ${sec.id}`,
      artist: `PDF Audio Reader (${state.currentDoc.title})`,
      album: state.currentDoc.filename || 'PDF Audiobook',
      artwork: [
        { src: 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=256&auto=format&fit=crop&q=80', sizes: '256x256', type: 'image/jpeg' },
        { src: 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=512&auto=format&fit=crop&q=80', sizes: '512x512', type: 'image/jpeg' }
      ]
    });
  }

  // Event Listeners
  function setupEventListeners() {
    btnPlayPause.addEventListener('click', () => {
      initWebAudio();
      togglePlayPause();
    });
    btnReadAloudSec.addEventListener('click', () => {
      initWebAudio();
      togglePlayPause();
    });
    btnSkipBack.addEventListener('click', () => skip(-15));
    btnSkipForward.addEventListener('click', () => skip(15));
    btnPrevChapter.addEventListener('click', prevChapter);
    btnNextChapter.addEventListener('click', nextChapter);

    btnSpeedToggle.addEventListener('click', cycleSpeed);
    btnVolumeBoost.addEventListener('click', cycleVolumeBoost);

    const navVolBtn = document.getElementById('nav-volume-boost');
    if (navVolBtn) navVolBtn.addEventListener('click', cycleVolumeBoost);

    const readerVolBtn = document.getElementById('reader-vol-btn');
    if (readerVolBtn) readerVolBtn.addEventListener('click', cycleVolumeBoost);

    document.querySelectorAll('.vol-opt-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const val = parseFloat(e.currentTarget.getAttribute('data-vol'));
        initWebAudio();
        applyVolumeBoost(val);
      });
    });

    btnVoiceQuick.addEventListener('click', () => openModal(settingsModal));

    if (btnPrecacheAll) {
      btnPrecacheAll.addEventListener('click', startPrecacheAll);
    }

    // Audio element events
    audio.addEventListener('timeupdate', () => {
      if (!isDraggingScrubber && audio.duration) {
        state.currentTime = audio.currentTime;
        audioScrubber.value = (audio.currentTime / audio.duration) * 100;
        timeCurrent.textContent = formatTime(audio.currentTime);
        timeTotal.textContent = formatTime(audio.duration);
        highlightActiveParagraphByTime(audio.currentTime, audio.duration);

        // When reaching 75% of the current chapter, ensure upcoming 5 chapters are pre-buffered into phone memory
        if (audio.currentTime / audio.duration > 0.75) {
          triggerMultiChapterPreload();
        }
      }
    });

    audio.addEventListener('loadedmetadata', () => {
      state.audioDuration = audio.duration;
      timeTotal.textContent = formatTime(audio.duration);
      audio.playbackRate = state.playbackSpeed;
      if (state.resumeTime && state.resumeTime < audio.duration) {
        audio.currentTime = state.resumeTime;
        state.resumeTime = null;
      }
    });

    audio.addEventListener('ended', () => {
      // Continuous Auto-advance to next chapter automatically without requiring user interaction
      if (state.currentDoc && state.currentSectionIndex < state.currentDoc.sections.length - 1) {
        state.isAutoAdvancing = true;
        state.isPlaying = true;
        state.pendingAutoPlay = true;
        setSection(state.currentSectionIndex + 1, true);
      } else {
        state.isAutoAdvancing = false;
        pauseAudio();
      }
    });

    audio.addEventListener('play', () => {
      initWebAudio();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      state.isPlaying = true;
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    });

    audio.addEventListener('playing', () => {
      state.isAutoAdvancing = false;
      state.isLoadingAudio = false;
      state.pendingAutoPlay = false;
      state.isPlaying = true;
      updatePlayButtonUI(true, false);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    });

    audio.addEventListener('waiting', () => {
      state.isLoadingAudio = true;
      updatePlayButtonUI(false, true);
    });

    audio.addEventListener('canplay', async () => {
      state.isLoadingAudio = false;
      if (state.pendingAutoPlay || state.isPlaying || state.isAutoAdvancing) {
        state.pendingAutoPlay = false;
        try {
          if (audioCtx && audioCtx.state === 'suspended') {
            await audioCtx.resume();
          }
          await audio.play();
          state.isAutoAdvancing = false;
          state.isPlaying = true;
          updatePlayButtonUI(true, false);
        } catch (err) {
          console.warn('Auto-play playback error on canplay:', err);
        }
      } else {
        updatePlayButtonUI(false, false);
      }
    });

    audio.addEventListener('error', (e) => {
      console.error('Audio playback error:', e);
      // Auto-retry once if error occurred during chapter transition
      if (state.isAutoAdvancing && state.currentDoc) {
        setTimeout(() => {
          if (state.isAutoAdvancing && state.currentDoc) {
            const sec = state.currentDoc.sections[state.currentSectionIndex];
            if (sec) {
              loadSectionAudio(state.currentDoc.id, sec.id, true);
            }
          }
        }, 600);
        return;
      }
      state.isLoadingAudio = false;
      state.isAutoAdvancing = false;
      state.isPlaying = false;
      updatePlayButtonUI(false, false);
    });

    audio.addEventListener('pause', () => {
      // Ignore transient pause events when swapping audio.src during chapter transitions
      if (state.isAutoAdvancing) {
        return;
      }
      state.isPlaying = false;
      state.pendingAutoPlay = false;
      updatePlayButtonUI(false, false);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
      saveBookmark();
    });

    // Scrubber scrubbing
    audioScrubber.addEventListener('input', () => {
      isDraggingScrubber = true;
      if (audio.duration) {
        const seek = (audioScrubber.value / 100) * audio.duration;
        timeCurrent.textContent = formatTime(seek);
      }
    });

    audioScrubber.addEventListener('change', () => {
      if (audio.duration) {
        audio.currentTime = (audioScrubber.value / 100) * audio.duration;
      }
      isDraggingScrubber = false;
      saveBookmark();
    });

    // Modals
    btnOpenUpload.addEventListener('click', () => openModal(uploadModal));
    emptyUploadBtn.addEventListener('click', () => openModal(uploadModal));
    closeUploadModal.addEventListener('click', () => closeModal(uploadModal));

    btnOpenSettings.addEventListener('click', () => openModal(settingsModal));
    closeSettingsModal.addEventListener('click', () => closeModal(settingsModal));

    btnLoadSample.addEventListener('click', loadSampleDoc);
    emptySampleBtn.addEventListener('click', loadSampleDoc);

    // Dropzone
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFileSelected(e.target.files[0]);
      }
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleFileSelected(e.dataTransfer.files[0]);
      }
    });

    btnStartUpload.addEventListener('click', performUpload);

    // Save Settings
    btnSaveSettings.addEventListener('click', () => {
      state.selectedVoice = voiceSelect.value;
      localStorage.setItem('selected_voice', state.selectedVoice);

      updateVoiceButtonLabel();
      closeModal(settingsModal);

      // If currently playing, re-synthesize with new voice
      if (state.currentDoc) {
        loadSectionAudio(state.currentDoc.id, state.currentDoc.sections[state.currentSectionIndex].id, state.isPlaying);
      }
    });

    // Add Content Tabs
    if (tabBtnPdf) tabBtnPdf.addEventListener('click', () => switchTab('pane-pdf'));
    if (tabBtnWeb) tabBtnWeb.addEventListener('click', () => switchTab('pane-web'));
    if (tabBtnText) tabBtnText.addEventListener('click', () => switchTab('pane-text'));

    if (emptyWebBtn) {
      emptyWebBtn.addEventListener('click', () => {
        openModal(uploadModal);
        switchTab('pane-web');
      });
    }

    if (btnStartPlaylist) btnStartPlaylist.addEventListener('click', performPlaylistCreation);
    if (btnStartRawtext) btnStartRawtext.addEventListener('click', performRawTextCreation);
  }

  function switchTab(targetPaneId) {
    const tabs = [
      { btn: tabBtnPdf, pane: panePdf, id: 'pane-pdf' },
      { btn: tabBtnWeb, pane: paneWeb, id: 'pane-web' },
      { btn: tabBtnText, pane: paneText, id: 'pane-text' }
    ];

    tabs.forEach(t => {
      if (t.btn && t.pane) {
        if (t.id === targetPaneId) {
          t.btn.classList.add('active');
          t.pane.classList.remove('hidden');
        } else {
          t.btn.classList.remove('active');
          t.pane.classList.add('hidden');
        }
      }
    });

    if (webStatusMsg) {
      webStatusMsg.className = 'status-feedback';
      webStatusMsg.style.display = 'none';
    }
    if (rawtextStatusMsg) {
      rawtextStatusMsg.className = 'status-feedback';
      rawtextStatusMsg.style.display = 'none';
    }
    if (window.lucide) window.lucide.createIcons();
  }

  function cycleVolumeBoost() {
    initWebAudio();
    const currentIdx = VOLUME_BOOST_STEPS.indexOf(state.volumeBoost);
    const nextIdx = (currentIdx + 1) % VOLUME_BOOST_STEPS.length;
    const nextBoost = VOLUME_BOOST_STEPS[nextIdx];
    applyVolumeBoost(nextBoost);
  }

  function handleFileSelected(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      alert('Please select a valid PDF file.');
      return;
    }
    selectedUploadFile = file;
    selectedFileName.textContent = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
    selectedFileName.style.display = 'block';
    btnStartUpload.disabled = false;
  }

  async function performUpload() {
    if (!selectedUploadFile) return;

    btnStartUpload.disabled = true;
    btnStartUpload.innerHTML = '<span class="pulse-spinner"></span> Extracting & Cleaning PDF...';

    const formData = new FormData();
    formData.append('file', selectedUploadFile);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Upload failed');
      }

      const doc = await res.json();
      closeModal(uploadModal);
      btnStartUpload.innerHTML = '<span>Process & Read Aloud</span>';
      selectedUploadFile = null;
      selectedFileName.style.display = 'none';

      loadDocumentIntoUI(doc, 0, true);
    } catch (e) {
      alert(`Error processing PDF: ${e.message}`);
      btnStartUpload.disabled = false;
      btnStartUpload.innerHTML = '<span>Process & Read Aloud</span>';
    }
  }

  async function performPlaylistCreation() {
    const rawUrls = playlistUrlsInput.value.trim();
    const urls = rawUrls.split('\n').map(u => u.trim()).filter(u => u.length > 0);

    if (urls.length === 0) {
      webStatusMsg.className = 'status-feedback error';
      webStatusMsg.textContent = 'Please enter at least one URL to fetch.';
      webStatusMsg.style.display = 'block';
      return;
    }

    btnStartPlaylist.disabled = true;
    btnStartPlaylist.innerHTML = '<span class="pulse-spinner"></span> <span>Fetching & Creating Playlist...</span>';
    webStatusMsg.className = 'status-feedback info';
    webStatusMsg.textContent = `Extracting ${urls.length} ${urls.length === 1 ? 'article' : 'articles'} and generating audio chapters...`;
    webStatusMsg.style.display = 'block';

    try {
      const res = await fetch('/api/playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: urls,
          title: playlistTitleInput.value.trim() || null
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to create playlist');
      }

      const doc = await res.json();
      closeModal(uploadModal);
      playlistUrlsInput.value = '';
      playlistTitleInput.value = '';
      webStatusMsg.style.display = 'none';
      btnStartPlaylist.disabled = false;
      btnStartPlaylist.innerHTML = '<i data-lucide="play-circle" style="width: 16px; height: 16px;"></i> <span>Create Audio Playlist</span>';

      loadDocumentIntoUI(doc, 0, true);
    } catch (e) {
      webStatusMsg.className = 'status-feedback error';
      webStatusMsg.innerHTML = `<strong>Error:</strong> ${e.message}<br><small style="margin-top: 4px; display: block;">Tip: If this website blocks automated scrapers, switch to the <strong>Paste Text</strong> tab to paste the article directly.</small>`;
      webStatusMsg.style.display = 'block';
      btnStartPlaylist.disabled = false;
      btnStartPlaylist.innerHTML = '<i data-lucide="play-circle" style="width: 16px; height: 16px;"></i> <span>Try Again</span>';
    }
  }

  async function performRawTextCreation() {
    const text = rawtextBodyInput.value.trim();
    if (!text) {
      rawtextStatusMsg.className = 'status-feedback error';
      rawtextStatusMsg.textContent = 'Please paste some article or newsletter text to read.';
      rawtextStatusMsg.style.display = 'block';
      return;
    }

    btnStartRawtext.disabled = true;
    btnStartRawtext.innerHTML = '<span class="pulse-spinner"></span> <span>Formatting Text for Speech...</span>';
    rawtextStatusMsg.className = 'status-feedback info';
    rawtextStatusMsg.textContent = 'Cleaning text formatting and chunking into chapters...';
    rawtextStatusMsg.style.display = 'block';

    try {
      const res = await fetch('/api/raw-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          title: rawtextTitleInput.value.trim() || null
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to process text');
      }

      const doc = await res.json();
      closeModal(uploadModal);
      rawtextBodyInput.value = '';
      rawtextTitleInput.value = '';
      rawtextStatusMsg.style.display = 'none';
      btnStartRawtext.disabled = false;
      btnStartRawtext.innerHTML = '<i data-lucide="play-circle" style="width: 16px; height: 16px;"></i> <span>Process & Read Aloud</span>';

      loadDocumentIntoUI(doc, 0, true);
    } catch (e) {
      rawtextStatusMsg.className = 'status-feedback error';
      rawtextStatusMsg.textContent = `Error: ${e.message}`;
      rawtextStatusMsg.style.display = 'block';
      btnStartRawtext.disabled = false;
      btnStartRawtext.innerHTML = '<i data-lucide="play-circle" style="width: 16px; height: 16px;"></i> <span>Try Again</span>';
    }
  }

  async function loadSampleDoc() {
    try {
      const res = await fetch('/api/sample', { method: 'POST' });
      const doc = await res.json();
      loadDocumentIntoUI(doc, 0, true);
    } catch (e) {
      alert(`Error loading sample document: ${e.message}`);
    }
  }

  async function loadLastSessionOrDocuments() {
    try {
      const res = await fetch('/api/documents');
      const data = await res.json();
      if (data.documents && data.documents.length > 0) {
        const lastDocId = localStorage.getItem('last_doc_id') || data.documents[0].id;
        const targetDoc = data.documents.find(d => d.id === lastDocId) || data.documents[0];

        // Check for bookmark
        const bkRes = await fetch(`/api/bookmark/${targetDoc.id}`);
        const bookmark = await bkRes.json();

        let initialSection = 0;
        if (bookmark && bookmark.section_id) {
          const secIdx = targetDoc.sections.findIndex(s => s.id === bookmark.section_id);
          if (secIdx !== -1) {
            initialSection = secIdx;
            state.resumeTime = bookmark.current_time || 0;
          }
        }
        loadDocumentIntoUI(targetDoc, initialSection, false);
      }
    } catch (e) {
      console.warn('No previous documents loaded:', e);
    }
  }

  function loadDocumentIntoUI(doc, sectionIndex = 0, autoPlay = false) {
    state.currentDoc = doc;
    localStorage.setItem('last_doc_id', doc.id);

    emptyState.style.display = 'none';
    docCard.style.display = 'block';
    chaptersCard.style.display = 'block';
    readerView.style.display = 'block';

    docTitle.textContent = doc.title;
    if (doc.type === 'playlist') {
      docPages.innerHTML = `<i data-lucide="globe" style="width: 14px; height: 14px; display: inline;"></i> ${doc.num_pages || 1} Articles`;
    } else if (doc.type === 'text') {
      docPages.innerHTML = `<i data-lucide="file-text" style="width: 14px; height: 14px; display: inline;"></i> Text Article`;
    } else {
      docPages.innerHTML = `<i data-lucide="file-text" style="width: 14px; height: 14px; display: inline;"></i> ${doc.num_pages || 0} Pages`;
    }
    docDuration.innerHTML = `<i data-lucide="clock" style="width: 14px; height: 14px; display: inline;"></i> ~${doc.total_estimated_minutes || 0} mins`;
    chapterCountBadge.textContent = `${doc.sections.length} Sections`;

    renderChaptersList();
    setSection(sectionIndex, autoPlay);
    checkCacheStatus();

    // Auto-trigger full document background pre-caching so all chapters are ready with 0s wait
    startPrecacheAllSilently();

    // Also preload upcoming chapters into browser memory
    triggerMultiChapterPreload();

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  async function checkCacheStatus() {
    if (!state.currentDoc) return;
    try {
      const res = await fetch(`/api/documents/${state.currentDoc.id}/cache_status?voice=${encodeURIComponent(state.selectedVoice)}`);
      const data = await res.json();
      if (cachePercentageBadge) {
        cachePercentageBadge.textContent = `${data.percentage}% (${data.cached_sections}/${data.total_sections})`;
      }
      if (btnPrecacheAll) {
        if (data.is_fully_cached) {
          btnPrecacheAll.innerHTML = '<i data-lucide="check" style="width: 13px; height: 13px;"></i> <span>100% Pre-buffered Ready</span>';
          btnPrecacheAll.style.background = '#e6f7ec';
          btnPrecacheAll.style.color = '#1a7f37';
          if (cachePollInterval) {
            clearInterval(cachePollInterval);
            cachePollInterval = null;
          }
        } else {
          btnPrecacheAll.innerHTML = '<i data-lucide="zap" style="width: 13px; height: 13px;"></i> <span>Pre-buffer All Chapters (0s Wait)</span>';
          btnPrecacheAll.style.background = '#edeaf4';
          btnPrecacheAll.style.color = 'var(--primary-dark)';
        }
      }
      if (window.lucide) window.lucide.createIcons();
    } catch (e) {
      console.warn('Could not check cache status:', e);
    }
  }

  async function startPrecacheAllSilently() {
    if (!state.currentDoc) return;
    try {
      await fetch(`/api/documents/${state.currentDoc.id}/precache_all?voice=${encodeURIComponent(state.selectedVoice)}`, {
        method: 'POST'
      });
      if (cachePollInterval) clearInterval(cachePollInterval);
      cachePollInterval = setInterval(checkCacheStatus, 3000);
      checkCacheStatus();
    } catch (e) {
      console.warn('Silent precache failed:', e);
    }
  }

  async function startPrecacheAll() {
    if (!state.currentDoc) return;
    btnPrecacheAll.innerHTML = '<span class="pulse-spinner" style="width: 12px; height: 12px;"></span> <span>Pre-buffering Chapters...</span>';

    try {
      await fetch(`/api/documents/${state.currentDoc.id}/precache_all?voice=${encodeURIComponent(state.selectedVoice)}`, {
        method: 'POST'
      });

      if (cachePollInterval) clearInterval(cachePollInterval);
      cachePollInterval = setInterval(checkCacheStatus, 3000);
      checkCacheStatus();
    } catch (e) {
      alert(`Pre-cache failed: ${e.message}`);
    }
  }

  // Multi-Chapter Phone Storage Pre-loader (Always keeps next 5 chapters ready in device memory)
  async function triggerMultiChapterPreload() {
    if (!state.currentDoc) return;
    const docId = state.currentDoc.id;
    const voice = state.selectedVoice;

    for (let offset = 1; offset <= 5; offset++) {
      const targetIdx = state.currentSectionIndex + offset;
      if (targetIdx < state.currentDoc.sections.length) {
        const sec = state.currentDoc.sections[targetIdx];
        const cacheKey = `${docId}_${sec.id}_${voice}`;
        if (!audioBlobCache.has(cacheKey) && !prefetchingKeys.has(cacheKey)) {
          prefetchingKeys.add(cacheKey);
          fetchAudioBlob(docId, sec.id, voice).then(blobUrl => {
            if (blobUrl) audioBlobCache.set(cacheKey, blobUrl);
            prefetchingKeys.delete(cacheKey);
          }).catch(() => prefetchingKeys.delete(cacheKey));
        }
      }
    }
  }

  async function fetchAudioBlob(docId, sectionId, voice) {
    const url = `/api/documents/${docId}/sections/${sectionId}/audio?voice=${encodeURIComponent(voice)}`;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch (e) {
      console.warn(`Could not preload section ${sectionId}:`, e);
      return null;
    }
  }

  function renderChaptersList() {
    chaptersList.innerHTML = '';
    state.currentDoc.sections.forEach((sec, idx) => {
      const item = document.createElement('div');
      item.className = `chapter-item ${idx === state.currentSectionIndex ? 'active' : ''}`;
      item.id = `chap-item-${idx}`;

      item.innerHTML = `
        <div class="chapter-title">${sec.title || `Section ${sec.id}`}</div>
        <div class="chapter-time">${sec.estimated_minutes ? sec.estimated_minutes + 'm' : ''}</div>
      `;

      item.addEventListener('click', () => {
        initWebAudio();
        setSection(idx, true);
      });

      chaptersList.appendChild(item);
    });
  }

  function setSection(index, autoPlay = false) {
    if (!state.currentDoc || !state.currentDoc.sections[index]) return;
    state.currentSectionIndex = index;

    // Update active highlight in chapters list
    document.querySelectorAll('.chapter-item').forEach((el, idx) => {
      el.classList.toggle('active', idx === index);
    });

    const activeItem = document.getElementById(`chap-item-${index}`);
    if (activeItem) {
      activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const sec = state.currentDoc.sections[index];
    readingSectionNumber.textContent = `Section ${sec.id} of ${state.currentDoc.sections.length}`;
    readingSectionTitle.textContent = sec.title || `Section ${sec.id}`;

    // Update track names in player
    playerTrackName.textContent = sec.title || `Section ${sec.id}`;
    playerTrackSub.textContent = `${state.currentDoc.title} • Section ${sec.id}/${state.currentDoc.sections.length}`;

    // Render paragraphs in reader view
    renderReaderParagraphs(sec.text);

    // Update MediaSession
    updateMediaSessionMetadata();

    // Load Audio with 0ms Instant Local Blob Handoff
    loadSectionAudio(state.currentDoc.id, sec.id, autoPlay);

    // Trigger next 5 chapters background pre-fetch
    triggerMultiChapterPreload();
  }

  let currentParagraphOffsets = [];
  let totalSectionChars = 0;

  function renderReaderParagraphs(text) {
    readerParagraphs.innerHTML = '';
    currentParagraphOffsets = [];
    totalSectionChars = 0;

    const rawParagraphs = text.split('\n\n').map(p => p.trim()).filter(p => p.length > 0);
    if (rawParagraphs.length === 0) return;

    let cumulativeChars = 0;
    rawParagraphs.forEach((p, idx) => {
      const pEl = document.createElement('p');
      pEl.className = 'paragraph-block';
      pEl.id = `para-${idx}`;
      pEl.textContent = p;

      const pLen = p.length;
      const startChar = cumulativeChars;
      const endChar = cumulativeChars + pLen;
      cumulativeChars += pLen;

      const offsetData = { start: startChar, end: endChar, el: pEl, index: idx };
      currentParagraphOffsets.push(offsetData);

      // Tap paragraph to play/scrub to exact timestamp
      pEl.addEventListener('click', () => {
        if (totalSectionChars > 0 && audio.duration) {
          const ratio = startChar / totalSectionChars;
          audio.currentTime = ratio * audio.duration;
          playAudio();
          highlightParagraphByIndex(idx);
        }
      });

      readerParagraphs.appendChild(pEl);
    });

    totalSectionChars = cumulativeChars;
  }

  function highlightParagraphByIndex(targetIdx) {
    currentParagraphOffsets.forEach((item, idx) => {
      const isActive = idx === targetIdx;
      item.el.classList.toggle('highlight-reading', isActive);
      if (isActive) {
        item.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  function highlightActiveParagraphByTime(currentTime, duration) {
    if (!duration || duration <= 0 || currentParagraphOffsets.length === 0 || totalSectionChars <= 0) return;
    
    const progressRatio = Math.min(Math.max(currentTime / duration, 0), 0.999);
    const currentCharTarget = progressRatio * totalSectionChars;

    let activeIdx = 0;
    for (let i = 0; i < currentParagraphOffsets.length; i++) {
      if (currentCharTarget >= currentParagraphOffsets[i].start) {
        activeIdx = i;
      }
    }

    currentParagraphOffsets.forEach((item, idx) => {
      item.el.classList.toggle('highlight-reading', idx === activeIdx);
    });
  }

  async function loadSectionAudio(docId, sectionId, autoPlay = false) {
    const voice = state.selectedVoice;
    const cacheKey = `${docId}_${sectionId}_${voice}`;

    state.currentTime = 0;
    audioScrubber.value = 0;
    timeCurrent.textContent = '0:00';

    if (autoPlay) {
      state.isPlaying = true;
      state.isAutoAdvancing = true;
      state.pendingAutoPlay = true;
      state.isLoadingAudio = true;
      updatePlayButtonUI(false, true);
    }

    // Check if we already have the Blob preloaded in phone memory (0ms lag!)
    const cachedBlobUrl = audioBlobCache.get(cacheKey);
    if (cachedBlobUrl) {
      audio.src = cachedBlobUrl;
    } else {
      const directUrl = `/api/documents/${docId}/sections/${sectionId}/audio?voice=${encodeURIComponent(voice)}`;
      audio.src = directUrl;
      // Also cache it into blob in background
      fetchAudioBlob(docId, sectionId, voice).then(blobUrl => {
        if (blobUrl) audioBlobCache.set(cacheKey, blobUrl);
      });
    }

    // Immediately trigger play if autoPlay is requested
    if (autoPlay) {
      try {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          await playPromise;
          state.isAutoAdvancing = false;
          state.pendingAutoPlay = false;
          state.isLoadingAudio = false;
          state.isPlaying = true;
          updatePlayButtonUI(true, false);
        }
      } catch (e) {
        // canplay listener will automatically catch and resume playback as soon as data streams in
        console.log('Audio buffering, will auto-play on canplay:', e);
      }
    } else {
      state.isLoadingAudio = false;
      updatePlayButtonUI(false, false);
    }
  }

  function togglePlayPause() {
    if (!state.currentDoc) return;
    if (audio.paused) {
      playAudio();
    } else {
      pauseAudio();
    }
  }

  async function playAudio() {
    try {
      initWebAudio();
      if (audioCtx && audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      state.isAutoAdvancing = false;
      state.isPlaying = true;
      state.isLoadingAudio = true;
      updatePlayButtonUI(false, true);
      await audio.play();
      state.isLoadingAudio = false;
      updatePlayButtonUI(true, false);
    } catch (e) {
      console.error('Audio play failed:', e);
      state.isLoadingAudio = false;
      updatePlayButtonUI(false, false);
    }
  }

  function pauseAudio() {
    state.isAutoAdvancing = false;
    state.isPlaying = false;
    state.pendingAutoPlay = false;
    audio.pause();
  }

  function skip(seconds) {
    if (audio.duration) {
      audio.currentTime = Math.min(Math.max(audio.currentTime + seconds, 0), audio.duration);
      saveBookmark();
    }
  }

  function prevChapter() {
    if (state.currentSectionIndex > 0) {
      initWebAudio();
      state.isAutoAdvancing = true;
      setSection(state.currentSectionIndex - 1, true);
    }
  }

  function nextChapter() {
    if (state.currentDoc && state.currentSectionIndex < state.currentDoc.sections.length - 1) {
      initWebAudio();
      state.isAutoAdvancing = true;
      setSection(state.currentSectionIndex + 1, true);
    }
  }

  function cycleSpeed() {
    const currentIdx = SPEED_STEPS.indexOf(state.playbackSpeed);
    const nextIdx = (currentIdx + 1) % SPEED_STEPS.length;
    state.playbackSpeed = SPEED_STEPS[nextIdx];
    audio.playbackRate = state.playbackSpeed;
    btnSpeedToggle.textContent = `${state.playbackSpeed}x`;
  }

  function updatePlayButtonUI(isPlaying, isLoading = false) {
    if (isLoading) {
      btnPlayPause.innerHTML = '<span class="pulse-spinner"></span>';
      btnReadAloudSec.innerHTML = '<span class="pulse-spinner" style="width: 14px; height: 14px;"></span>';
    } else if (isPlaying) {
      btnPlayPause.innerHTML = '<i data-lucide="pause" style="width: 24px; height: 24px;"></i>';
      btnReadAloudSec.innerHTML = '<i data-lucide="pause" style="width: 18px; height: 18px;"></i>';
    } else {
      btnPlayPause.innerHTML = '<i data-lucide="play" style="width: 24px; height: 24px;"></i>';
      btnReadAloudSec.innerHTML = '<i data-lucide="play" style="width: 18px; height: 18px;"></i>';
    }
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  async function saveBookmark() {
    if (!state.currentDoc) return;
    const sec = state.currentDoc.sections[state.currentSectionIndex];
    if (!sec) return;

    const payload = {
      doc_id: state.currentDoc.id,
      section_id: sec.id,
      current_time: audio.currentTime,
      duration: audio.duration || 0,
      voice: state.selectedVoice,
      playback_rate: state.playbackSpeed
    };

    try {
      await fetch('/api/bookmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn('Bookmark save failed:', e);
    }
  }

  function openModal(modal) {
    modal.classList.add('open');
  }

  function closeModal(modal) {
    modal.classList.remove('open');
  }

  // Kickoff initialization
  init();
});

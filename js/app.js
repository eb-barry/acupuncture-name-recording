import { getMeridianNames, getPointsForMeridian, buildFileName } from './points-data.js';
import {
  saveDirectoryHandle, loadDirectoryHandle, verifyPermission,
  getMeridianProgress, markPointDone, resetMeridianProgress, isPointDone,
} from './storage.js';
import { ContinuousRecorder, trimSilence, normalizeVolume, applyFadeInOut, encodeMp3, hasSpeech } from './audio-recorder.js';

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);

const screens = {
  home: $('screen-home'),
  recording: $('screen-recording'),
  complete: $('screen-complete'),
};

const el = {
  settingsBtn: $('settingsBtn'),
  errorBanner: $('errorBanner'),
  errorBannerText: $('errorBannerText'),
  errorBannerClose: $('errorBannerClose'),

  modeCardSequential: $('modeCardSequential'),
  modeCardSingle: $('modeCardSingle'),
  sequentialPicker: $('sequentialPicker'),
  singlePicker: $('singlePicker'),
  meridianSelect: $('meridianSelect'),
  meridianSelectSingle: $('meridianSelectSingle'),
  pointSelectSingle: $('pointSelectSingle'),
  startSequentialBtn: $('startSequentialBtn'),
  startSingleBtn: $('startSingleBtn'),
  reRecordMeridianBtn: $('reRecordMeridianBtn'),
  sequentialProgressHint: $('sequentialProgressHint'),

  recModeBadge: $('recModeBadge'),
  recMeridianBadge: $('recMeridianBadge'),
  recPointName: $('recPointName'),
  recPointProgress: $('recPointProgress'),
  statusLight: $('statusLight'),
  statusText: $('statusText'),
  statusHint: $('statusHint'),
  saveNextBtn: $('saveNextBtn'),
  saveNextLabel: $('saveNextLabel'),
  cancelRecordingBtn: $('cancelRecordingBtn'),

  completeMeridianName: $('completeMeridianName'),
  completeProgress: $('completeProgress'),
  nextMeridianBtn: $('nextMeridianBtn'),

  folderPrompt: $('folderPrompt'),
  folderPromptText: $('folderPromptText'),
  folderPromptBtn: $('folderPromptBtn'),
};

// ---------- App state ----------
const state = {
  mode: 'sequential', // 'sequential' | 'single'
  meridianName: null,
  points: [],
  index: 0,
  directoryHandle: null,
  saving: false,
};

const recorder = new ContinuousRecorder();

// ---------- Error banner ----------
function showError(message) {
  el.errorBannerText.textContent = message;
  el.errorBanner.hidden = false;
}
el.errorBannerClose.addEventListener('click', () => { el.errorBanner.hidden = true; });

// ---------- Screen switching ----------
function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].hidden = key !== name;
  }
}

// ---------- Folder handling ----------
async function ensureDirectoryHandle() {
  if (state.directoryHandle) {
    const ok = await verifyPermission(state.directoryHandle, false);
    if (ok) return true;
  }
  if (!state.directoryHandle) {
    const saved = await loadDirectoryHandle().catch(() => null);
    if (saved) {
      state.directoryHandle = saved;
      const ok = await verifyPermission(saved, false);
      if (ok) return true;
    }
  }
  return promptForFolder();
}

function promptForFolder() {
  return new Promise((resolve) => {
    el.folderPromptText.textContent = state.directoryHandle
      ? '瀏覽器需要你重新確認資料夾的存取權限，才能繼續存檔。'
      : '請選擇一個資料夾，錄好的 MP3 檔案會直接存進去。';
    el.folderPrompt.hidden = false;

    const onClick = async () => {
      el.folderPromptBtn.removeEventListener('click', onClick);
      el.folderPrompt.hidden = true;
      try {
        let handle = state.directoryHandle;
        if (handle) {
          const granted = await verifyPermission(handle, true);
          if (!granted) handle = null;
        }
        if (!handle) {
          handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        }
        state.directoryHandle = handle;
        await saveDirectoryHandle(handle);
        resolve(true);
      } catch (e) {
        console.error(e);
        showError('沒有選擇資料夾，或權限被拒絕，無法開始錄音。');
        resolve(false);
      }
    };
    el.folderPromptBtn.addEventListener('click', onClick);
  });
}

el.settingsBtn.addEventListener('click', async () => {
  await promptForFolder();
});

// ---------- Populate dropdowns ----------
async function populateMeridianSelects() {
  const names = await getMeridianNames();
  for (const select of [el.meridianSelect, el.meridianSelectSingle]) {
    select.innerHTML = '';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
  }
  await refreshSequentialHint();
  await populateSinglePointSelect();
}

async function refreshSequentialHint() {
  const meridianName = el.meridianSelect.value;
  if (!meridianName) return;
  const points = await getPointsForMeridian(meridianName);
  const progress = getMeridianProgress(meridianName);
  const doneCount = progress.done.length;
  if (doneCount > 0 && doneCount < points.length) {
    el.sequentialProgressHint.hidden = false;
    el.sequentialProgressHint.textContent = `上次錄到第 ${doneCount} / ${points.length} 穴，將從下一穴繼續。`;
  } else if (doneCount >= points.length && points.length > 0) {
    el.sequentialProgressHint.hidden = false;
    el.sequentialProgressHint.textContent = `這條經脈已經全部錄完（${points.length} / ${points.length}）。`;
  } else {
    el.sequentialProgressHint.hidden = true;
  }
  el.reRecordMeridianBtn.hidden = doneCount === 0;
}

async function populateSinglePointSelect() {
  const meridianName = el.meridianSelectSingle.value;
  if (!meridianName) return;
  const points = await getPointsForMeridian(meridianName);
  el.pointSelectSingle.innerHTML = '';
  for (const p of points) {
    const opt = document.createElement('option');
    opt.value = p.code;
    const done = isPointDone(meridianName, p.code);
    opt.textContent = `${p.code}　${p.name}${done ? '　✓ 已錄' : ''}`;
    el.pointSelectSingle.appendChild(opt);
  }
}

el.meridianSelect.addEventListener('change', refreshSequentialHint);
el.meridianSelectSingle.addEventListener('change', populateSinglePointSelect);

// ---------- Mode cards ----------
function setMode(mode) {
  state.mode = mode;
  el.modeCardSequential.setAttribute('aria-pressed', String(mode === 'sequential'));
  el.modeCardSingle.setAttribute('aria-pressed', String(mode === 'single'));
  el.sequentialPicker.hidden = mode !== 'sequential';
  el.singlePicker.hidden = mode !== 'single';
}
el.modeCardSequential.addEventListener('click', () => setMode('sequential'));
el.modeCardSingle.addEventListener('click', () => setMode('single'));

// ---------- Re-record whole meridian ----------
el.reRecordMeridianBtn.addEventListener('click', async () => {
  const meridianName = el.meridianSelect.value;
  if (!confirm(`確定要重錄整條「${meridianName}」嗎？之前的進度紀錄會被清除（已存在硬碟裡的舊檔案會在你重新錄製時被覆蓋）。`)) return;
  resetMeridianProgress(meridianName);
  await refreshSequentialHint();
});

// ---------- Start sequential recording ----------
el.startSequentialBtn.addEventListener('click', async () => {
  const meridianName = el.meridianSelect.value;
  if (!meridianName) return;

  const points = await getPointsForMeridian(meridianName);
  if (points.length === 0) {
    showError('這條經脈目前沒有穴位資料。');
    return;
  }

  const folderOk = await ensureDirectoryHandle();
  if (!folderOk) return;

  const progress = getMeridianProgress(meridianName);
  let startIndex = points.findIndex((p) => !progress.done.includes(p.code));
  if (startIndex === -1) startIndex = 0; // 全部錄完了，重新從頭（使用者也可以先按重錄整條經脈）

  state.meridianName = meridianName;
  state.points = points;
  state.index = startIndex;

  await beginRecordingSession('sequential');
});

// ---------- Start single-point recording ----------
el.startSingleBtn.addEventListener('click', async () => {
  const meridianName = el.meridianSelectSingle.value;
  const code = el.pointSelectSingle.value;
  if (!meridianName || !code) return;

  const points = await getPointsForMeridian(meridianName);
  const index = points.findIndex((p) => p.code === code);
  if (index === -1) {
    showError('找不到這個穴位。');
    return;
  }

  const folderOk = await ensureDirectoryHandle();
  if (!folderOk) return;

  state.meridianName = meridianName;
  state.points = points;
  state.index = index;

  await beginRecordingSession('single');
});

// ---------- Recording session ----------
async function beginRecordingSession(mode) {
  try {
    await recorder.reset();
    await recorder.start();
  } catch (e) {
    console.error(e);
    showError('無法取得麥克風權限，請檢查瀏覽器的麥克風授權設定。');
    return;
  }

  recorder.onLevel = (level) => {
    if (state.saving) return;
    setStatus(level > 0.02 ? 'recording' : 'ready');
  };

  el.recModeBadge.textContent = mode === 'sequential' ? '逐穴錄音' : '單穴錄音';
  el.saveNextLabel.textContent = mode === 'sequential' ? '儲存並下一穴' : '儲存錄音';

  showScreen('recording');
  renderCurrentPoint();
  window.addEventListener('beforeunload', beforeUnloadHandler);
}

function renderCurrentPoint() {
  const point = state.points[state.index];
  el.recMeridianBadge.textContent = state.meridianName;
  el.recPointName.textContent = point.name;
  el.recPointProgress.textContent = `${state.index + 1} / ${state.points.length}`;
  setStatus('ready');
}

function setStatus(newState) {
  el.statusLight.dataset.state = newState;
  if (newState === 'ready') {
    el.statusText.textContent = 'READY';
    el.statusHint.textContent = '請開始錄音，說出穴位名稱';
  } else if (newState === 'recording') {
    el.statusText.textContent = 'RECORDING';
    el.statusHint.textContent = '正在錄音中...';
  } else if (newState === 'saving') {
    el.statusText.textContent = 'SAVING';
    el.statusHint.textContent = '正在儲存檔案...';
  }
}

async function saveCurrentPointAndAdvance(mode) {
  if (state.saving) return;
  state.saving = true;
  setStatus('saving');
  el.saveNextBtn.disabled = true;

  try {
    const { left, right } = recorder.cutSegment();
    if (!hasSpeech(left, right)) {
      const proceed = confirm('這一段幾乎沒有偵測到聲音，確定要照樣存檔嗎？（取消的話可以重新講一次再按 Enter）');
      if (!proceed) {
        state.saving = false;
        el.saveNextBtn.disabled = false;
        setStatus('ready');
        return;
      }
    }
    const trimmed = trimSilence(left, right);
    const normalized = normalizeVolume(trimmed.left, trimmed.right);
    const faded = applyFadeInOut(normalized.left, normalized.right);
    const blob = encodeMp3(faded.left, faded.right);

    const point = state.points[state.index];
    const fileName = buildFileName(state.meridianName, point);
    const fileHandle = await state.directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    markPointDone(state.meridianName, point.code);

    if (mode === 'sequential') {
      if (state.index + 1 < state.points.length) {
        state.index += 1;
        state.saving = false;
        el.saveNextBtn.disabled = false;
        renderCurrentPoint();
      } else {
        endSequentialSession();
      }
    } else {
      // 單穴模式：存完就回到選擇畫面
      state.saving = false;
      el.saveNextBtn.disabled = false;
      await recorder.reset();
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      showScreen('home');
      await populateSinglePointSelect();
    }
  } catch (e) {
    console.error(e);
    state.saving = false;
    el.saveNextBtn.disabled = false;
    setStatus('ready');
    if (e && e.name === 'NotFoundError') {
      showError('儲存資料夾似乎已經被移動或刪除，請重新選擇資料夾。');
      state.directoryHandle = null;
    } else if (e && e.name === 'QuotaExceededError') {
      showError('硬碟空間可能不足，存檔失敗。');
    } else {
      showError('存檔時發生錯誤，請重試一次。');
    }
  }
}

async function endSequentialSession() {
  window.removeEventListener('beforeunload', beforeUnloadHandler);
  await recorder.reset();
  el.completeMeridianName.textContent = state.meridianName;
  el.completeProgress.textContent = `${state.points.length} / ${state.points.length}`;
  showScreen('complete');
}

el.saveNextBtn.addEventListener('click', () => saveCurrentPointAndAdvance(state.mode));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (screens.recording.hidden) return;
  e.preventDefault();
  saveCurrentPointAndAdvance(state.mode);
});

el.cancelRecordingBtn.addEventListener('click', async () => {
  if (!confirm('目前這個穴位還沒存檔的錄音內容會遺失，確定要返回嗎？')) return;
  window.removeEventListener('beforeunload', beforeUnloadHandler);
  await recorder.reset();
  state.saving = false;
  showScreen('home');
  await refreshSequentialHint();
  await populateSinglePointSelect();
});

el.nextMeridianBtn.addEventListener('click', async () => {
  showScreen('home');
  await refreshSequentialHint();
});

function beforeUnloadHandler(e) {
  e.preventDefault();
  e.returnValue = '';
}

// ---------- Init ----------
async function init() {
  if (!('showDirectoryPicker' in window)) {
    showError('這個瀏覽器不支援直接存檔到資料夾的功能，請使用桌面版 Chrome 或 Edge。');
  }
  try {
    const saved = await loadDirectoryHandle();
    if (saved) state.directoryHandle = saved;
  } catch (e) {
    console.error(e);
  }
  await populateMeridianSelects();
  setMode('sequential');
  showScreen('home');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.error('SW 註冊失敗', e));
  }
}

init();

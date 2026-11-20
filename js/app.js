import { getMeridianNames, getPointsForMeridian, buildWavFileName, buildIntroWavFileName, buildIntroText, meridianHasCountIntro, INTRO_CODE } from './points-data.js';
import {
  saveDirectoryHandle, loadDirectoryHandle, saveListenDirectoryHandle, loadListenDirectoryHandle,
  verifyPermission, getSubDirectory,
  getMeridianProgress, getResetAt, markPointDone, resetMeridianProgress, replaceAllProgress, isPointDone,
} from './storage.js';
import { scanRecordedFiles } from './sync.js';
import { ContinuousRecorder, encodeWav, hasSpeech } from './audio-recorder.js';
import { runOptimization, CERTIFIED_DIR } from './optimizer.js';
import { buildMeridianPlaylist, buildSinglePlaylist, buildIntroPlaylist, findListenDirectory, loadAudioUrl } from './listen.js';
import { withZhuyin } from './zhuyin.js';

const RAW_WAV_DIR = 'raw_wav';

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);

const screens = {
  home: $('screen-home'),
  recording: $('screen-recording'),
  complete: $('screen-complete'),
  listen: $('screen-listen'),
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
  syncStatus: $('syncStatus'),
  syncBtn: $('syncBtn'),
  modeCardOptimize: $('modeCardOptimize'),
  optimizePicker: $('optimizePicker'),
  optimizeProgress: $('optimizeProgress'),
  optimizeBar: $('optimizeBar'),
  optimizeStatus: $('optimizeStatus'),
  optimizeResult: $('optimizeResult'),
  startOptimizeBtn: $('startOptimizeBtn'),
  cancelOptimizeBtn: $('cancelOptimizeBtn'),
  sequentialProgressHint: $('sequentialProgressHint'),

  modeCardListen: $('modeCardListen'),
  listenPicker: $('listenPicker'),
  listenSubMeridian: $('listenSubMeridian'),
  listenSubSingle: $('listenSubSingle'),
  listenMeridianOnly: $('listenMeridianOnly'),
  listenPointOnly: $('listenPointOnly'),
  meridianSelectListen: $('meridianSelectListen'),
  meridianSelectListenSingle: $('meridianSelectListenSingle'),
  pointSelectListen: $('pointSelectListen'),
  startListenBtn: $('startListenBtn'),
  listenChooseFolderBtn: $('listenChooseFolderBtn'),
  listenFolderStatus: $('listenFolderStatus'),

  listenModeBadge: $('listenModeBadge'),
  listenMeridianBadge: $('listenMeridianBadge'),
  listenPointName: $('listenPointName'),
  listenPointProgress: $('listenPointProgress'),
  listenAudio: $('listenAudio'),
  listenPrevBtn: $('listenPrevBtn'),
  listenPlayPauseBtn: $('listenPlayPauseBtn'),
  listenNextBtn: $('listenNextBtn'),
  listenHint: $('listenHint'),
  listenBackBtn: $('listenBackBtn'),

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
  folderPromptTitle: $('folderPromptTitle'),
  folderPromptText: $('folderPromptText'),
  folderPromptBtn: $('folderPromptBtn'),
};

// ---------- App state ----------
const state = {
  mode: 'sequential', // 'sequential' | 'single' | 'optimize' | 'listen'
  stage: 'points', // 'intro' | 'points'（單穴模式一律是 'points'）
  meridianName: null,
  points: [],
  index: 0,
  directoryHandle: null,
  listenDirectoryHandle: null,
  listenDirectoryReady: false,
  listenDirectoryPersistenceWarning: false,
  saving: false,
  listenSub: 'meridian', // 'meridian' | 'single'
};

// 經穴試聽的播放狀態（跟上面錄音用的 state 分開，播放不會動到錄音進度）
const listenState = {
  playlist: [],
  index: -1,
  currentUrl: null,
  isPlaying: false,
};

const recorder = new ContinuousRecorder();

// ---------- Error banner ----------
function showError(message) {
  el.errorBannerText.textContent = message;
  el.errorBanner.hidden = false;
}
function hideError() {
  el.errorBanner.hidden = true;
}
el.errorBannerClose.addEventListener('click', hideError);

// ---------- Screen switching ----------
function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].hidden = key !== name;
  }
}

// ---------- Folder handling ----------
async function ensureDirectoryHandle({ mode = 'readwrite', purpose = 'recording' } = {}) {
  if (state.directoryHandle) {
    const ok = await verifyPermission(state.directoryHandle, false, mode);
    if (ok) return true;
  }
  if (!state.directoryHandle) {
    const saved = await loadDirectoryHandle().catch(() => null);
    if (saved) {
      state.directoryHandle = saved;
      const ok = await verifyPermission(saved, false, mode);
      if (ok) return true;
    }
  }
  return promptForFolder({ mode, purpose });
}

let activeFolderPrompt = null;

function promptForFolder({ mode = 'readwrite', purpose = 'recording' } = {}) {
  return new Promise((resolve) => {
    const isListen = purpose === 'listen';
    if (activeFolderPrompt) {
      el.folderPromptBtn.removeEventListener('click', activeFolderPrompt.onClick);
      activeFolderPrompt.resolve(false);
    }

    el.folderPromptTitle.textContent = isListen ? '需要選擇試聽資料夾' : '需要選擇儲存資料夾';
    el.folderPromptText.textContent = isListen
      ? `請選擇包含 MP3 的資料夾，或包含 ${CERTIFIED_DIR} 子資料夾的錄音專案資料夾。`
      : '請選擇錄音專案資料夾。WAV 母帶與優化後的 MP3 會存進對應的子資料夾。';
    el.folderPrompt.hidden = false;

    const session = { resolve, onClick: null };
    activeFolderPrompt = session;
    session.onClick = async () => {
      if (activeFolderPrompt !== session) return;
      el.folderPromptBtn.removeEventListener('click', session.onClick);
      activeFolderPrompt = null;
      el.folderPrompt.hidden = true;
      let handle;
      try {
        // 必須在這個點擊裡直接開啟選檔視窗，不能先 await 舊資料夾的授權。
        // 否則使用者操作過期，瀏覽器會把新選擇當成取消。
        handle = await window.showDirectoryPicker({ mode });
      } catch (e) {
        if (!e || e.name !== 'AbortError') console.error(e);
        const folderLabel = isListen ? '試聽資料夾' : '儲存資料夾';
        if (e && e.name === 'AbortError') {
          showError(`已取消選擇${folderLabel}。`);
        } else if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
          showError(`瀏覽器未授權此${folderLabel}，請再按一次並在系統視窗中選取資料夾。`);
        } else {
          showError(`選擇${folderLabel}時發生錯誤${e && e.name ? `（${e.name}）` : ''}，請再試一次。`);
        }
        resolve(false);
        return;
      }

      if (isListen) {
        state.listenDirectoryHandle = handle;
        state.listenDirectoryReady = true;
        state.listenDirectoryPersistenceWarning = false;
        setListenFolderStatus('正在掃描 MP3 檔…');
        try {
          await saveListenDirectoryHandle(handle);
        } catch (e) {
          // IndexedDB 在無痕模式、儲存空間受限或部分 WebView 中可能無法保存
          // FileSystemDirectoryHandle；本次頁面仍可直接使用已取得的 handle，不應判定選擇失敗。
          console.warn('無法記住試聽資料夾，本次仍會繼續使用', e);
          state.listenDirectoryPersistenceWarning = true;
        }
      } else {
        state.directoryHandle = handle;
        try {
          await saveDirectoryHandle(handle);
        } catch (e) {
          console.warn('無法記住儲存資料夾，本次仍會繼續使用', e);
        }
      }
      hideError();
      resolve(handle);
    };
    el.folderPromptBtn.addEventListener('click', session.onClick);
  });
}

async function ensureListenDirectoryHandle() {
  // 本次頁面已由使用者選過時直接沿用；實際掃描若失去權限會拋錯並顯示明確訊息。
  // 不在每次按「開始試聽」前再次 queryPermission，避免部分瀏覽器把只讀控制代碼誤判成需重選。
  if (state.listenDirectoryHandle && state.listenDirectoryReady) return state.listenDirectoryHandle;

  if (state.listenDirectoryHandle) {
    if (await verifyPermission(state.listenDirectoryHandle, false, 'read')) {
      state.listenDirectoryReady = true;
      return state.listenDirectoryHandle;
    }
    return promptForFolder({ mode: 'read', purpose: 'listen' });
  }

  const saved = await loadListenDirectoryHandle().catch(() => null);
  if (saved) {
    state.listenDirectoryHandle = saved;
    if (await verifyPermission(saved, false, 'read')) {
      state.listenDirectoryReady = true;
      return saved;
    }
    return promptForFolder({ mode: 'read', purpose: 'listen' });
  }

  // 向下相容：若先前只儲存過錄音專案根目錄，也可直接從該目錄尋找成品。
  if (state.directoryHandle && await verifyPermission(state.directoryHandle, false, 'read')) {
    state.listenDirectoryHandle = state.directoryHandle;
    state.listenDirectoryReady = true;
    try {
      await saveListenDirectoryHandle(state.directoryHandle);
    } catch (e) {
      console.warn('無法記住試聽資料夾，本次仍會繼續使用', e);
      state.listenDirectoryPersistenceWarning = true;
    }
    return state.directoryHandle;
  }

  return promptForFolder({ mode: 'read', purpose: 'listen' });
}

el.settingsBtn.addEventListener('click', async () => {
  const selected = await promptForFolder({ mode: 'readwrite', purpose: 'recording' });
  if (selected) await refreshHome();
});

// ---------- 與資料夾同步錄音進度 ----------
// 進度的事實來源是資料夾裡實際存在的 WAV 母帶。啟動、回到首頁、開始錄音前都會掃描，
// 使用者手動刪除或補進檔案，進度與經脈清單的 ✅ 都會跟著更新。
function setSyncStatus(kind, info = {}) {
  let text = '';
  const folderName = state.directoryHandle && state.directoryHandle.name;
  if (kind === 'none') {
    text = '尚未選擇儲存資料夾。按「重新掃描資料夾」選擇後，進度會依資料夾裡實際的錄音檔顯示。';
  } else if (kind === 'need-permission') {
    text = folderName
      ? `已記住儲存資料夾「${folderName}」，尚未取得權限。按「重新掃描資料夾」可重新選擇。`
      : '目前顯示的是上次記錄的進度，尚未與資料夾比對。按「重新掃描資料夾」重新選擇後就會更新。';
  } else if (kind === 'synced') {
    const t = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const selected = folderName ? `已選擇儲存資料夾：「${folderName}」。` : '';
    text = info.rawDirMissing
      ? `${selected}已與資料夾同步（${t}）：還沒有 raw_wav 資料夾（尚未錄過音）。`
      : `${selected}已與資料夾同步（${t}）：找到 ${info.wavFiles} 個 WAV 母帶。`;
    if (info.legacyMp3 > 0) {
      text += ` 另有 ${info.legacyMp3} 個舊版 MP3（沒有 WAV 母帶，需重錄才能做音訊優化，不列入進度）。`;
    }
  } else if (kind === 'error') {
    text = `掃描資料夾失敗：${info.message || '未知錯誤'}`;
  }
  el.syncStatus.textContent = text;
}

// 只在「已經有資料夾權限」時掃描（不會自己跳出權限提示，權限提示必須由使用者點擊觸發）。
async function syncProgressFromDisk() {
  if (!state.directoryHandle) {
    setSyncStatus('none');
    return false;
  }
  try {
    if (!(await verifyPermission(state.directoryHandle, false))) {
      setSyncStatus('need-permission');
      return false;
    }
    const names = await getMeridianNames();
    const meridians = new Map();
    for (const name of names) meridians.set(name, await getPointsForMeridian(name));
    const { doneByMeridian, stats } = await scanRecordedFiles(state.directoryHandle, meridians, getResetAt);
    replaceAllProgress(doneByMeridian);
    setSyncStatus('synced', stats);
    return true;
  } catch (e) {
    console.error(e);
    setSyncStatus('error', {
      message: e && e.name === 'NotFoundError' ? '找不到儲存資料夾（可能被移動或刪除了），請重新選擇資料夾。' : e && e.message,
    });
    return false;
  }
}

// 回到首頁：先與資料夾同步，再重畫經脈清單與提示
async function refreshHome() {
  await syncProgressFromDisk();
  await populateMeridianSelects();
}

el.syncBtn.addEventListener('click', async () => {
  const folderOk = await ensureDirectoryHandle();
  if (!folderOk) return;
  await refreshHome();
});

// ---------- Populate dropdowns ----------
async function isMeridianFullyDone(meridianName) {
  const points = await getPointsForMeridian(meridianName);
  if (points.length === 0) return false;
  const progress = getMeridianProgress(meridianName);
  const introDone = progress.done.includes(INTRO_CODE);
  const allPointsDone = points.every((p) => progress.done.includes(p.code));
  return introDone && allPointsDone;
}

async function populateMeridianSelects() {
  const names = await getMeridianNames();
  for (const select of [el.meridianSelect, el.meridianSelectSingle, el.meridianSelectListen, el.meridianSelectListenSingle]) {
    const previousValue = select.value;
    select.innerHTML = '';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      // 原生 <select> 的 <option> 在 Chrome 裡幾乎不吃自訂顏色（下拉選單清單是瀏覽器用系統原生元件畫的），
      // 沒辦法把勾勾局部染成紅色；改用「✅」這個內建就有顏色的 emoji 字元當作完成標記，任何瀏覽器都能正確顯示。
      // 這個「✅」代表的是錄音進度（raw_wav），不是試聽用的「有沒有優化成品」，兩件事分開看。
      const done = await isMeridianFullyDone(name);
      opt.textContent = done ? `✅ ${name}` : name;
      select.appendChild(opt);
    }
    if (previousValue && names.includes(previousValue)) select.value = previousValue;
  }
  await refreshSequentialHint();
  await populateSinglePointSelect();
  await populateListenPointSelect();
}

async function refreshSequentialHint() {
  const meridianName = el.meridianSelect.value;
  if (!meridianName) return;
  const points = await getPointsForMeridian(meridianName);
  const progress = getMeridianProgress(meridianName);
  const introDone = progress.done.includes(INTRO_CODE);
  const doneCount = progress.done.filter((code) => code !== INTRO_CODE).length;

  if (introDone && doneCount >= points.length && points.length > 0) {
    el.sequentialProgressHint.hidden = false;
    el.sequentialProgressHint.textContent = `這條經脈已經全部錄完（含總穴數口播 + ${points.length} / ${points.length} 穴）。`;
  } else if (doneCount > 0 || introDone) {
    el.sequentialProgressHint.hidden = false;
    el.sequentialProgressHint.textContent = introDone
      ? `上次錄到第 ${doneCount} / ${points.length} 穴，將從下一穴繼續。`
      : `尚未錄製「經脈總穴數」口播，開始時會先錄這一段，再繼續錄穴位（已錄 ${doneCount} / ${points.length} 穴）。`;
  } else {
    el.sequentialProgressHint.hidden = true;
  }
  el.reRecordMeridianBtn.hidden = doneCount === 0 && !introDone;
}

function restoreSelection(select, previousValue, fallbackValue) {
  const values = [...select.options].map((option) => option.value);
  if (previousValue && values.includes(previousValue)) select.value = previousValue;
  else if (fallbackValue && values.includes(fallbackValue)) select.value = fallbackValue;
}

function appendCountIntroOption(select, meridianName, { showDone = false } = {}) {
  if (!meridianHasCountIntro(meridianName)) return;
  const opt = document.createElement('option');
  opt.value = INTRO_CODE;
  const done = showDone && isPointDone(meridianName, INTRO_CODE);
  opt.textContent = `穴位總數音檔${done ? '　✓ 已錄' : ''}`;
  select.appendChild(opt);
}

async function populateSinglePointSelect() {
  const meridianName = el.meridianSelectSingle.value;
  if (!meridianName) return;
  const previousValue = el.pointSelectSingle.value;
  const points = await getPointsForMeridian(meridianName);
  el.pointSelectSingle.innerHTML = '';
  appendCountIntroOption(el.pointSelectSingle, meridianName, { showDone: true });
  for (const p of points) {
    const opt = document.createElement('option');
    opt.value = p.code;
    const done = isPointDone(meridianName, p.code);
    opt.textContent = `${p.code}　${p.name}${done ? '　✓ 已錄' : ''}`;
    el.pointSelectSingle.appendChild(opt);
  }
  // 總數音檔放第一個，但切換經脈時仍預設第一個穴位，避免忘記改選就覆蓋口播。
  restoreSelection(el.pointSelectSingle, previousValue, points[0] && points[0].code);
}

async function populateListenPointSelect() {
  const meridianName = el.meridianSelectListenSingle.value;
  if (!meridianName) return;
  const previousValue = el.pointSelectListen.value;
  const points = await getPointsForMeridian(meridianName);
  el.pointSelectListen.innerHTML = '';
  appendCountIntroOption(el.pointSelectListen, meridianName);
  for (const p of points) {
    const opt = document.createElement('option');
    opt.value = p.code;
    opt.textContent = `${p.code}　${p.name}`;
    el.pointSelectListen.appendChild(opt);
  }
  restoreSelection(el.pointSelectListen, previousValue, points[0] && points[0].code);
}

el.meridianSelect.addEventListener('change', refreshSequentialHint);
el.meridianSelectSingle.addEventListener('change', populateSinglePointSelect);
el.meridianSelectListenSingle.addEventListener('change', populateListenPointSelect);

// ---------- 經穴試聽：子模式切換（逐經脈 / 單穴）----------
function setListenSub(sub) {
  state.listenSub = sub;
  el.listenSubMeridian.setAttribute('aria-pressed', String(sub === 'meridian'));
  el.listenSubSingle.setAttribute('aria-pressed', String(sub === 'single'));
  el.listenMeridianOnly.hidden = sub !== 'meridian';
  el.listenPointOnly.hidden = sub !== 'single';
}
el.listenSubMeridian.addEventListener('click', () => setListenSub('meridian'));
el.listenSubSingle.addEventListener('click', () => setListenSub('single'));

function setListenFolderStatus(detail = '') {
  const folderName = state.listenDirectoryHandle && state.listenDirectoryHandle.name;
  const selected = folderName ? `已選擇資料夾：「${folderName}」` : '尚未選擇試聽資料夾';
  const persistenceNote = state.listenDirectoryPersistenceWarning
    ? '（本次可正常使用；瀏覽器無法記住此資料夾，下次開啟時可能需要重選）'
    : '';
  el.listenFolderStatus.hidden = false;
  el.listenFolderStatus.textContent = [selected, detail, persistenceNote].filter(Boolean).join('；');
}

async function prepareListenDirectory({ showEmptyError = false } = {}) {
  const rootHandle = await ensureListenDirectoryHandle();
  if (!rootHandle) {
    setListenFolderStatus();
    return null;
  }

  try {
    setListenFolderStatus('正在掃描 MP3 檔…');
    const result = await findListenDirectory(rootHandle);
    if (!result) {
      listenState.certifiedDir = null;
      setListenFolderStatus('找不到 MP3 檔');
      if (showEmptyError) {
        showError(`所選資料夾與其 ${CERTIFIED_DIR} 子資料夾中都沒有 MP3 檔，請改選已有錄音成品的資料夾。`);
      }
      return null;
    }

    listenState.certifiedDir = result.dirHandle;
    const scanLocation = result.dirHandle.name !== rootHandle.name
      ? `掃描子資料夾「${result.dirHandle.name}」，找到 ${result.mp3Count} 個 MP3 檔`
      : `找到 ${result.mp3Count} 個 MP3 檔`;
    setListenFolderStatus(scanLocation);
    return result.dirHandle;
  } catch (e) {
    console.error(e);
    listenState.certifiedDir = null;
    const permissionLost = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    if (permissionLost) state.listenDirectoryReady = false;
    setListenFolderStatus(permissionLost ? '讀取權限已失效' : `掃描失敗${e && e.name ? `（${e.name}）` : ''}`);
    showError(permissionLost
      ? '瀏覽器已失去試聽資料夾的讀取權限，請按「選擇 MP3 資料夾」重新授權。'
      : '無法掃描所選資料夾，請重新選擇資料夾後再試一次。');
    return null;
  }
}

// ---------- Mode cards ----------
function setMode(mode) {
  state.mode = mode;
  el.modeCardSequential.setAttribute('aria-pressed', String(mode === 'sequential'));
  el.modeCardSingle.setAttribute('aria-pressed', String(mode === 'single'));
  el.modeCardOptimize.setAttribute('aria-pressed', String(mode === 'optimize'));
  el.modeCardListen.setAttribute('aria-pressed', String(mode === 'listen'));
  el.sequentialPicker.hidden = mode !== 'sequential';
  el.singlePicker.hidden = mode !== 'single';
  el.optimizePicker.hidden = mode !== 'optimize';
  el.listenPicker.hidden = mode !== 'listen';
}
el.modeCardSequential.addEventListener('click', () => setMode('sequential'));
el.modeCardSingle.addEventListener('click', () => setMode('single'));
el.modeCardOptimize.addEventListener('click', () => setMode('optimize'));
el.modeCardListen.addEventListener('click', async () => {
  setMode('listen');
  await prepareListenDirectory({ showEmptyError: true });
});
el.listenChooseFolderBtn.addEventListener('click', async () => {
  const selected = await promptForFolder({ mode: 'read', purpose: 'listen' });
  if (selected) await prepareListenDirectory({ showEmptyError: true });
});

// ---------- 音訊優化（批次）----------
let optimizeCancelRequested = false;

function renderOptimizeResult(result) {
  const lines = [];
  lines.push(`${result.cancelled ? '已取消。' : '完成！'}共處理 ${result.rows.length} / ${result.total} 個檔案：正常 ${result.ok} 個，建議檢查 ${result.review.length} 個，失敗 ${result.failed.length} 個。`);
  lines.push('成品在 certified_recording 資料夾，詳細品質報告見 optimization_report.csv。');
  let html = lines.map((l) => `<div>${l}</div>`).join('');
  const attention = [...result.review, ...result.failed];
  if (attention.length > 0) {
    html += '<div style="margin-top:6px">建議檢查／可能需要重錄：</div><ul>';
    for (const r of attention.slice(0, 50)) {
      const why = r.status === 'failed' ? `失敗：${r.error}` : r.status === 'no-speech' ? '整段沒有偵測到語音' : (r.flags || []).join('、');
      html += `<li>${r.name}（${why}）</li>`;
    }
    if (attention.length > 50) html += `<li>…另外還有 ${attention.length - 50} 個，請看 CSV 報告</li>`;
    html += '</ul>';
  }
  el.optimizeResult.innerHTML = html;
  el.optimizeResult.hidden = false;
}

el.startOptimizeBtn.addEventListener('click', async () => {
  const folderOk = await ensureDirectoryHandle();
  if (!folderOk) return;

  optimizeCancelRequested = false;
  el.optimizeResult.hidden = true;
  el.optimizeProgress.hidden = false;
  el.optimizeBar.value = 0;
  el.optimizeStatus.textContent = '準備中（第一次會載入降噪模型）…';
  el.startOptimizeBtn.disabled = true;
  el.cancelOptimizeBtn.hidden = false;
  window.addEventListener('beforeunload', beforeUnloadHandler);

  try {
    const result = await runOptimization(state.directoryHandle, {
      shouldCancel: () => optimizeCancelRequested,
      onProgress: ({ index, total, name }) => {
        el.optimizeBar.max = total;
        el.optimizeBar.value = index;
        el.optimizeStatus.textContent = `處理中 ${index + 1} / ${total}：${name}`;
      },
    });
    el.optimizeBar.value = el.optimizeBar.max;
    el.optimizeStatus.textContent = result.cancelled ? '已取消' : '全部處理完成';
    renderOptimizeResult(result);
  } catch (e) {
    console.error(e);
    el.optimizeProgress.hidden = true;
    showError(e && e.message ? e.message : '音訊優化失敗，請重試一次。');
  } finally {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    el.startOptimizeBtn.disabled = false;
    el.cancelOptimizeBtn.hidden = true;
  }
});

el.cancelOptimizeBtn.addEventListener('click', () => {
  optimizeCancelRequested = true;
  el.optimizeStatus.textContent = '正在取消（做完手上這個檔案就會停止）…';
});

// ---------- 經穴試聽 ----------
// 掃描所選資料夾（或其 certified_recording 子資料夾）並依既有檔名規則播放 MP3；
// 跟錄音、優化都不同，這裡完全不寫檔。
el.startListenBtn.addEventListener('click', async () => {
  const certifiedDir = await prepareListenDirectory({ showEmptyError: true });
  if (!certifiedDir) {
    return;
  }

  let playlist, modeLabel;
  if (state.listenSub === 'meridian') {
    const meridianName = el.meridianSelectListen.value;
    if (!meridianName) return;
    const points = await getPointsForMeridian(meridianName);
    playlist = await buildMeridianPlaylist(certifiedDir, meridianName, points);
    modeLabel = '逐經脈試聽';
    listenState.meridianName = meridianName;
  } else {
    const meridianName = el.meridianSelectListenSingle.value;
    const code = el.pointSelectListen.value;
    if (!meridianName || !code) return;
    const points = await getPointsForMeridian(meridianName);
    if (code === INTRO_CODE) {
      if (!meridianHasCountIntro(meridianName)) return;
      playlist = await buildIntroPlaylist(certifiedDir, meridianName, points);
    } else {
      const point = points.find((p) => p.code === code);
      if (!point) return;
      playlist = await buildSinglePlaylist(certifiedDir, meridianName, point);
    }
    modeLabel = '單穴試聽';
    listenState.meridianName = meridianName;
  }

  if (!playlist.some((item) => item.exists)) {
    showError('資料夾裡雖然有 MP3，但沒有符合這個範圍與既有檔名規則的穴位錄音。');
    return;
  }

  listenState.playlist = playlist;
  listenState.certifiedDir = certifiedDir;
  el.listenModeBadge.textContent = modeLabel;
  el.listenMeridianBadge.textContent = listenState.meridianName;

  showScreen('listen');
  const firstIndex = playlist.findIndex((item) => item.exists);
  await loadListenIndex(firstIndex, { autoplay: true });
});

function listenPointLabel(item, playlist) {
  if (item.code === INTRO_CODE) return '穴位總數音檔';
  const pointsOnly = playlist.filter((p) => p.code !== INTRO_CODE);
  const pos = pointsOnly.findIndex((p) => p.code === item.code);
  return `${pos + 1} / ${pointsOnly.length}`;
}

async function loadListenIndex(index, { autoplay = false } = {}) {
  const { playlist } = listenState;
  if (index < 0) { el.listenHint.textContent = '已經是第一個了。'; return; }
  if (index >= playlist.length) {
    el.listenAudio.pause();
    el.listenHint.textContent = '已經播完這個範圍的最後一個了。';
    return;
  }
  const item = playlist[index];

  if (!item.exists) {
    // 缺檔：跳過，往同一方向找下一個存在的
    const dir = index >= listenState.index ? 1 : -1;
    const next = index + dir;
    if (next < 0 || next >= playlist.length) {
      el.listenHint.textContent = '這個方向沒有更多已完成優化的穴位了。';
      return;
    }
    await loadListenIndex(next, { autoplay });
    return;
  }

  listenState.index = index;
  el.listenPointName.textContent = withZhuyin(item.label);
  el.listenPointProgress.textContent = listenPointLabel(item, playlist);

  if (listenState.currentUrl) URL.revokeObjectURL(listenState.currentUrl);
  try {
    listenState.currentUrl = await loadAudioUrl(listenState.certifiedDir, item.fileName);
  } catch (e) {
    console.error(e);
    el.listenHint.textContent = `讀取「${item.fileName}」失敗，可能檔案被移動或刪除了。`;
    return;
  }
  el.listenAudio.src = listenState.currentUrl;

  const missingCount = playlist.filter((p) => !p.exists).length;
  el.listenHint.textContent = missingCount > 0 ? `（這個範圍裡還有 ${missingCount} 個穴位尚未優化，會自動跳過）` : '';

  if (autoplay) {
    try {
      await el.listenAudio.play();
    } catch (e) {
      console.error(e);
    }
  }
}

function updatePlayPauseIcon() {
  el.listenPlayPauseBtn.innerHTML = listenState.isPlaying ? '&#10074;&#10074;' : '&#9654;';
}

el.listenPlayPauseBtn.addEventListener('click', async () => {
  if (el.listenAudio.paused) {
    try { await el.listenAudio.play(); } catch (e) { console.error(e); }
  } else {
    el.listenAudio.pause();
  }
});
el.listenAudio.addEventListener('play', () => { listenState.isPlaying = true; updatePlayPauseIcon(); });
el.listenAudio.addEventListener('pause', () => { listenState.isPlaying = false; updatePlayPauseIcon(); });

el.listenPrevBtn.addEventListener('click', () => {
  loadListenIndex(listenState.index - 1, { autoplay: listenState.isPlaying });
});
el.listenNextBtn.addEventListener('click', () => {
  loadListenIndex(listenState.index + 1, { autoplay: listenState.isPlaying });
});

// 逐經脈試聽時，播完自動接下一個；單穴試聽只有一筆，播完自然停止（沒有下一筆可跳）
el.listenAudio.addEventListener('ended', () => {
  loadListenIndex(listenState.index + 1, { autoplay: true });
});

el.listenBackBtn.addEventListener('click', () => {
  el.listenAudio.pause();
  el.listenAudio.removeAttribute('src');
  if (listenState.currentUrl) { URL.revokeObjectURL(listenState.currentUrl); listenState.currentUrl = null; }
  listenState.playlist = [];
  listenState.index = -1;
  showScreen('home');
});

// ---------- Re-record whole meridian ----------
el.reRecordMeridianBtn.addEventListener('click', async () => {
  const meridianName = el.meridianSelect.value;
  if (!confirm(`確定要重錄整條「${meridianName}」（含經脈總穴數口播）嗎？\n\n這條經脈會變成「尚未錄製」，硬碟裡的舊檔案不會被刪除，會在你重新錄好每一個時被覆蓋。`)) return;
  resetMeridianProgress(meridianName);
  await refreshHome();
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
  await syncProgressFromDisk(); // 開始前先以資料夾裡實際的檔案為準

  let progress = getMeridianProgress(meridianName);
  let introDone = progress.done.includes(INTRO_CODE);
  let startIndex = points.findIndex((p) => !progress.done.includes(p.code));

  if (startIndex === -1 && introDone) {
    // 口播與所有穴位都已經有檔案：視為使用者想整條重錄
    if (!confirm(`「${meridianName}」已經全部錄完了。要重新錄整條（含總穴數口播）嗎？\n舊檔案會在重新錄好時被覆蓋。`)) return;
    resetMeridianProgress(meridianName);
    progress = getMeridianProgress(meridianName);
    introDone = false;
    startIndex = 0;
  }
  if (startIndex === -1) startIndex = 0; // 只缺口播：錄完口播後會直接結束（穴位都已完成）

  state.meridianName = meridianName;
  state.points = points;
  state.index = startIndex;
  state.stage = introDone ? 'points' : 'intro';

  await beginRecordingSession('sequential');
});

// ---------- Start single-point recording ----------
el.startSingleBtn.addEventListener('click', async () => {
  const meridianName = el.meridianSelectSingle.value;
  const code = el.pointSelectSingle.value;
  if (!meridianName || !code) return;

  const points = await getPointsForMeridian(meridianName);
  const isIntro = code === INTRO_CODE;
  const index = isIntro ? 0 : points.findIndex((p) => p.code === code);
  if (isIntro && !meridianHasCountIntro(meridianName)) return;
  if (!isIntro && index === -1) {
    showError('找不到這個穴位。');
    return;
  }

  const folderOk = await ensureDirectoryHandle();
  if (!folderOk) return;
  await syncProgressFromDisk();

  state.meridianName = meridianName;
  state.points = points;
  state.index = index;
  state.stage = isIntro ? 'intro' : 'points';

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

  // 防呆重設：正常情況下上一個 session 結束時應該已經把這兩個狀態重設過，
  // 這裡再保險重設一次，避免任何遺漏的路徑讓下一個 session 一開始就卡住。
  state.saving = false;
  el.saveNextBtn.disabled = false;

  recorder.onLevel = (level) => {
    if (state.saving) return;
    setStatus(level > 0.02 ? 'recording' : 'ready');
  };

  el.recModeBadge.textContent = mode === 'sequential' ? '逐經脈錄音' : '單穴錄音';
  el.saveNextLabel.textContent = mode === 'sequential' && state.stage === 'points' ? '儲存並下一穴' : '儲存錄音';

  showScreen('recording');
  if (state.stage === 'intro') {
    renderIntro();
  } else {
    renderCurrentPoint();
  }
  window.addEventListener('beforeunload', beforeUnloadHandler);
}

// 從 fromIndex 開始，找第一個還沒錄的穴位（依國際代碼順序）；都錄完了回傳 -1
function findNextUndoneIndex(fromIndex) {
  const done = getMeridianProgress(state.meridianName).done;
  for (let i = fromIndex; i < state.points.length; i++) {
    if (!done.includes(state.points[i].code)) return i;
  }
  return -1;
}

function renderIntro() {
  const points = state.points;
  el.recMeridianBadge.textContent = state.meridianName;
  el.recPointName.textContent = withZhuyin(buildIntroText(state.meridianName, points));
  el.recPointName.classList.add('point-name--intro');
  el.recPointProgress.textContent = state.mode === 'sequential'
    ? '穴位總數音檔（逐經脈錄音前，先錄這一句）'
    : '穴位總數音檔';
  el.saveNextLabel.textContent = state.mode === 'sequential' ? '儲存並開始逐經脈錄音' : '儲存錄音';
  setStatus('ready');
}

function renderCurrentPoint() {
  const point = state.points[state.index];
  el.recMeridianBadge.textContent = state.meridianName;
  el.recPointName.textContent = withZhuyin(point.name);
  el.recPointName.classList.remove('point-name--intro');
  el.recPointProgress.textContent = `${state.index + 1} / ${state.points.length}`;
  el.saveNextLabel.textContent = state.mode === 'sequential' ? '儲存並下一穴' : '儲存錄音';
  setStatus('ready');
}

function setStatus(newState) {
  el.statusLight.dataset.state = newState;
  const isIntro = state.stage === 'intro';
  if (newState === 'ready') {
    el.statusText.textContent = 'READY';
    el.statusHint.textContent = isIntro ? '請開始錄音，照畫面唸出經脈總穴數' : '請開始錄音，說出穴位名稱';
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
    // 錄音當下只存原始 WAV 母帶（不裁切、不正規化、不降噪），這些處理留給「音訊優化」批次功能，
    // 用完整未處理過的音訊來做效果更好，也才有真正的原始素材可以重新處理、不用重錄。
    const blob = encodeWav(left, right);
    const rawWavDir = await getSubDirectory(state.directoryHandle, RAW_WAV_DIR);

    if (state.stage === 'intro') {
      const fileName = buildIntroWavFileName(state.meridianName, state.points);
      const fileHandle = await rawWavDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      markPointDone(state.meridianName, INTRO_CODE);

      if (mode === 'single') {
        state.saving = false;
        el.saveNextBtn.disabled = false;
        await recorder.reset();
        window.removeEventListener('beforeunload', beforeUnloadHandler);
        showScreen('home');
        await refreshHome();
        return;
      }

      state.stage = 'points';
      state.saving = false;
      el.saveNextBtn.disabled = false;
      const firstUndone = findNextUndoneIndex(0);
      if (firstUndone === -1) {
        await endSequentialSession(); // 穴位都已經錄好，只是補錄口播
      } else {
        state.index = firstUndone;
        renderCurrentPoint();
      }
      return;
    }

    const point = state.points[state.index];
    const fileName = buildWavFileName(state.meridianName, point);
    const fileHandle = await rawWavDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    markPointDone(state.meridianName, point.code);

    if (mode === 'sequential') {
      // 跳到下一個「還沒錄」的穴位：資料夾裡已存在的穴位不會被重錄（例如只補錄被刪掉的那幾個）
      const next = findNextUndoneIndex(state.index + 1);
      if (next !== -1) {
        state.index = next;
        state.saving = false;
        el.saveNextBtn.disabled = false;
        renderCurrentPoint();
      } else {
        await endSequentialSession();
      }
    } else {
      // 單穴模式：存完就回到選擇畫面
      state.saving = false;
      el.saveNextBtn.disabled = false;
      await recorder.reset();
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      showScreen('home');
      await refreshHome();
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
  state.saving = false;
  el.saveNextBtn.disabled = false;
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
  await refreshHome();
});

el.nextMeridianBtn.addEventListener('click', async () => {
  showScreen('home');
  await refreshHome();
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
    const savedListen = await loadListenDirectoryHandle();
    if (savedListen) state.listenDirectoryHandle = savedListen;
  } catch (e) {
    console.error(e);
  }
  await refreshHome(); // 每次啟動都先與資料夾裡實際的錄音檔同步
  setMode('sequential');
  setListenSub('meridian');
  showScreen('home');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.error('SW 註冊失敗', e));
  }
}

init();

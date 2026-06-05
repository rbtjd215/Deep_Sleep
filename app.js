/*
 * Deep Sleep — 4-7-8 호흡 가이드 & 수면 사운드
 * =============================================
 *
 * [오디오 엔진 — Web Audio API 기반 완전 무한 루프]
 *   - 바이노럴 비트: OscillatorNode (수학적 연속 사인파 → 끊김 불가)
 *   - 노이즈: AudioBufferSourceNode + 원형 크로스페이드 버퍼 (경계 없는 루프)
 *   - GainNode 기반 정밀 볼륨 제어
 *   - 무음 <audio> 보조 요소로 iOS 백그라운드 재생 보장
 */

// ════════════════════════════════════════════════
//  수면 사운드 타입
// ════════════════════════════════════════════════
const BEAT_TYPES = {
    delta1: {
        name: '델타 1Hz', desc: '깊은 수면',
        type: 'binaural', baseFreq: 100, beatFreq: 1, earphones: true,
    },
    delta3: {
        name: '델타 3Hz', desc: '수면 유도',
        type: 'binaural', baseFreq: 100, beatFreq: 3, earphones: true,
    },
    theta6: {
        name: '세타 6Hz', desc: '깊은 이완',
        type: 'binaural', baseFreq: 150, beatFreq: 6, earphones: true,
    },
    pink: {
        name: '핑크 노이즈', desc: '빗소리',
        type: 'noise', noiseKind: 'pink', earphones: false,
    },
    brown: {
        name: '브라운 노이즈', desc: '깊은 울림',
        type: 'noise', noiseKind: 'brown', earphones: false,
    },
};

// ════════════════════════════════════════════════
//  설정
// ════════════════════════════════════════════════
const BREATHING = {
    inhale: 4,
    hold:   7,
    exhale: 8,
};

const BEAT = {
    durationMin:  30,
    breathVolume: 0.15,
    sleepVolume:  0.40,
    loopSec:      45,      // 노이즈 버퍼 길이 (길수록 자연스러움)
    crossfadeSec: 3,       // 이중 버퍼 크로스페이드 길이
    sineAmp:      0.20,
    bgNoiseAmp:   0.012,
    noiseAmp:     0.25,
};

const TICK  = { volume: 0.12, freq: 600, decay: 0.06 };
const CHIME = {
    volume: 0.25,
    freqs: {
        inhale: [523.25, 659.25],
        hold:   [440.00, 554.37],
        exhale: [349.23, 440.00],
    },
    decay: 1.5,
};

// ════════════════════════════════════════════════
//  유틸: 안전한 localStorage 파싱
// ════════════════════════════════════════════════
function safeParseInt(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const num = parseInt(raw, 10);
    return isNaN(num) ? fallback : num;
}

// ════════════════════════════════════════════════
//  상태
// ════════════════════════════════════════════════
const state = {
    phase:          'idle',
    selectedBeat:   localStorage.getItem('selectedBeat') || 'delta3',
    selectedCycles: safeParseInt('selectedCycles', 4),
    userVolume:     safeParseInt('userVolume', 50),
    cycle:          0,
    breathInterval: null,
    breathTimeout:  null,
    sleepStart:     null,
    remainTimer:    null,
};

function getVolumeMultiplier() {
    // min=1이므로 0이 들어올 일은 없지만, 방어적으로 최솟값 보장
    const v = Math.max(1, state.userVolume) / 100;
    return Math.pow(v, 1.5);
}

let audioCtx        = null;
let sleepGainNode    = null;
let sleepSourceNodes     = [];
let sleepTimerIv         = null;
let noiseLoopControllers = [];

// ── 백그라운드 재생 보조 ──
let silentAudio = null;
let silentBlobUrl = null;
let wakeLock    = null;

// ════════════════════════════════════════════════
//  DOM
// ════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);

// ════════════════════════════════════════════════
//  AudioContext 관리
// ════════════════════════════════════════════════
function ensureAudioCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

// ════════════════════════════════════════════════
//  백그라운드 재생 보장
//  ─ 무음 WAV를 <audio loop>로 재생하여 미디어 세션 유지
//  ─ iOS Safari가 화면 잠금 후에도 AudioContext를 살려둠
//  ─ Wake Lock API로 화면 꺼짐도 방지 (지원 시)
// ════════════════════════════════════════════════

function createSilentWAV() {
    const sr = 22050, dur = 1, ch = 1, bps = 16;
    const len = sr * dur;
    const data = len * ch * (bps / 8);
    const size = 44 + data;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF');
    dv.setUint32(4, size - 8, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * ch * (bps / 8), true);
    dv.setUint16(32, ch * (bps / 8), true);
    dv.setUint16(34, bps, true);
    ws(36, 'data');
    dv.setUint32(40, data, true);
    // 모든 샘플 0 (무음) — ArrayBuffer는 기본 0이므로 추가 작업 불필요
    return new Blob([buf], { type: 'audio/wav' });
}

function startBackgroundKeepAlive() {
    // 무음 오디오 재생으로 미디어 세션 유지
    if (!silentAudio) {
        const blob = createSilentWAV();
        silentBlobUrl = URL.createObjectURL(blob);
        silentAudio = new Audio(silentBlobUrl);
        silentAudio.loop = true;
        silentAudio.volume = 0.01; // 거의 무음
    }
    silentAudio.play().catch(() => {});

    // Wake Lock API (지원하는 브라우저에서만)
    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen')
            .then(lock => { wakeLock = lock; })
            .catch(() => {});
    }
}

function stopBackgroundKeepAlive() {
    if (silentAudio) {
        silentAudio.pause();
        silentAudio.src = '';
        silentAudio = null;
    }
    if (silentBlobUrl) {
        URL.revokeObjectURL(silentBlobUrl);
        silentBlobUrl = null;
    }
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

// ════════════════════════════════════════════════
//  원형 크로스페이드 노이즈 버퍼 생성
//  ─ 버퍼 끝→처음이 자연스럽게 이어지도록
//    끝부분의 노이즈를 처음에 크로스페이드로 합성
// ════════════════════════════════════════════════

function generateSeamlessNoiseBuffer(ctx, kind, durationSec, amplitude) {
    const sr  = ctx.sampleRate;
    const len = Math.floor(sr * durationSec);
    // 크로스페이드 500ms — 노이즈 루프 경계를 완전히 감춤
    const cfLen    = Math.floor(sr * 0.5);
    const totalLen = len + cfLen;

    const buffer = ctx.createBuffer(2, len, sr);
    const tempL  = new Float32Array(totalLen);
    const tempR  = new Float32Array(totalLen);

    if (kind === 'pink') {
        let p0=0, p1=0, p2=0, p3=0, p4=0, p5=0, p6=0;
        for (let i = 0; i < totalLen; i++) {
            const w = Math.random() * 2 - 1;
            p0 = 0.99886*p0 + w*0.0555179;
            p1 = 0.99332*p1 + w*0.0750759;
            p2 = 0.96900*p2 + w*0.1538520;
            p3 = 0.86650*p3 + w*0.3104856;
            p4 = 0.55000*p4 + w*0.5329522;
            p5 = -0.7616*p5 - w*0.0168980;
            const pinkVal = (p0+p1+p2+p3+p4+p5+p6+w*0.5362) * 0.11;
            p6 = w * 0.115926;
            tempL[i] = tempR[i] = pinkVal * amplitude;
        }
    } else if (kind === 'brown') {
        let brownL = 0, brownR = 0;
        for (let i = 0; i < totalLen; i++) {
            const wL = Math.random() * 2 - 1;
            const wR = Math.random() * 2 - 1;
            brownL = (brownL + wL * 0.02) * 0.998;
            brownR = (brownR + wR * 0.02) * 0.998;
            tempL[i] = brownL * amplitude * 8;
            tempR[i] = brownR * amplitude * 8;
        }
    }

    // ── 원형 크로스페이드 적용 ──
    const dataL = buffer.getChannelData(0);
    const dataR = buffer.getChannelData(1);

    for (let i = 0; i < len; i++) {
        if (i < cfLen) {
            const fadeIn  = i / cfLen;
            const fadeOut = 1 - fadeIn;
            dataL[i] = tempL[i] * fadeIn + tempL[len + i] * fadeOut;
            dataR[i] = tempR[i] * fadeIn + tempR[len + i] * fadeOut;
        } else {
            dataL[i] = tempL[i];
            dataR[i] = tempR[i];
        }
    }

    return buffer;
}

// ════════════════════════════════════════════════
//  이중 버퍼 크로스페이드 스케줄링
//  ─ loop=true의 브라우저 갭 문제를 완전히 해결
//  ─ 두 세그먼트가 겹치며 gain 크로스페이드로 이어짐
//  ─ 루프 경계가 존재하지 않으므로 끊김 원천 불가
// ════════════════════════════════════════════════

function createSeamlessNoiseLoop(ctx, buffer, outputNode) {
    const CROSSFADE     = BEAT.crossfadeSec;
    const segDuration   = buffer.duration;
    const segInterval   = segDuration - CROSSFADE;

    let running         = true;
    let nextStartTime   = ctx.currentTime;
    let isFirstSegment  = true;
    let schedulerTimer  = null;
    const activeEntries = [];

    function scheduleSegment(startTime, skipFadeIn) {
        if (!running) return;
        const src = ctx.createBufferSource();
        const env = ctx.createGain();
        src.buffer = buffer;
        if (skipFadeIn) {
            env.gain.setValueAtTime(1, startTime);
        } else {
            env.gain.setValueAtTime(0.001, startTime);
            env.gain.linearRampToValueAtTime(1, startTime + CROSSFADE);
        }
        const fadeOutStart = startTime + segDuration - CROSSFADE;
        env.gain.setValueAtTime(1, fadeOutStart);
        env.gain.linearRampToValueAtTime(0.001, startTime + segDuration);
        src.connect(env).connect(outputNode);
        src.start(startTime);
        src.stop(startTime + segDuration + 0.1);
        const entry = { src, env };
        activeEntries.push(entry);
        src.onended = () => {
            try { src.disconnect(); } catch(e) {}
            try { env.disconnect(); } catch(e) {}
            const idx = activeEntries.indexOf(entry);
            if (idx >= 0) activeEntries.splice(idx, 1);
        };
    }

    function lookahead() {
        if (!running) return;
        while (nextStartTime < ctx.currentTime + 10) {
            scheduleSegment(nextStartTime, isFirstSegment);
            isFirstSegment = false;
            nextStartTime += segInterval;
        }
        schedulerTimer = setTimeout(lookahead, 5000);
    }

    lookahead();

    return {
        stop() {
            running = false;
            if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
            activeEntries.forEach(e => {
                try { e.src.stop(); }        catch(ex) {}
                try { e.src.disconnect(); }  catch(ex) {}
                try { e.env.disconnect(); }  catch(ex) {}
            });
            activeEntries.length = 0;
        }
    };
}

// ════════════════════════════════════════════════
//  실시간 노이즈 생성기 (AudioWorklet)
//  ─ 버퍼/루프/크로스페이드 없이 샘플 단위로 무한 생성
//  ─ 이음새가 존재하지 않으므로 끊김/음량변화 원천 불가
//  ─ 구형 브라우저에서는 이중 버퍼 방식으로 폴백
// ════════════════════════════════════════════════

const NOISE_WORKLET_CODE = `
class NoiseProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = options.processorOptions || {};
        this.kind = opts.kind || 'pink';
        this.amp  = opts.amplitude || 0.25;
        // 핑크 노이즈 필터 상태
        this.p = new Float64Array(7);
        // 브라운 노이즈 상태 (좌/우 독립)
        this.bL = 0;
        this.bR = 0;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || !out[0]) return true;
        const outL = out[0];
        const outR = out.length > 1 ? out[1] : null;

        if (this.kind === 'pink') {
            const p = this.p;
            for (let i = 0; i < outL.length; i++) {
                const w = Math.random() * 2 - 1;
                p[0] = 0.99886 * p[0] + w * 0.0555179;
                p[1] = 0.99332 * p[1] + w * 0.0750759;
                p[2] = 0.96900 * p[2] + w * 0.1538520;
                p[3] = 0.86650 * p[3] + w * 0.3104856;
                p[4] = 0.55000 * p[4] + w * 0.5329522;
                p[5] = -0.7616 * p[5] - w * 0.0168980;
                const val = (p[0]+p[1]+p[2]+p[3]+p[4]+p[5]+p[6]+w*0.5362) * 0.11 * this.amp;
                p[6] = w * 0.115926;
                outL[i] = val;
                if (outR) outR[i] = val;
            }
        } else {
            for (let i = 0; i < outL.length; i++) {
                this.bL = (this.bL + (Math.random() * 2 - 1) * 0.02) * 0.998;
                outL[i] = this.bL * this.amp * 8;
                if (outR) {
                    this.bR = (this.bR + (Math.random() * 2 - 1) * 0.02) * 0.998;
                    outR[i] = this.bR * this.amp * 8;
                }
            }
        }
        return true;
    }
}
registerProcessor('noise-processor', NoiseProcessor);
`;

let workletBlobUrl = null;

async function registerNoiseWorklet(ctx) {
    if (!ctx.audioWorklet) return false;
    try {
        if (!workletBlobUrl) {
            const blob = new Blob([NOISE_WORKLET_CODE], { type: 'application/javascript' });
            workletBlobUrl = URL.createObjectURL(blob);
        }
        await ctx.audioWorklet.addModule(workletBlobUrl);
        return true;
    } catch(e) {
        return false;
    }
}

function createNoiseWorkletNode(ctx, kind, amplitude) {
    return new AudioWorkletNode(ctx, 'noise-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { kind, amplitude }
    });
}

// ════════════════════════════════════════════════
//  WAV 파일 생성 (미리듣기 전용 — 3초 원샷)
// ════════════════════════════════════════════════

function generateWAV(beatKey, customDuration) {
    const config = BEAT_TYPES[beatKey];
    const sr     = 22050;
    const dur    = customDuration || 3;
    const len    = sr * dur;
    const ch     = 2;
    const bps    = 16;
    const data   = len * ch * (bps / 8);
    const size   = 44 + data;

    const buf = new ArrayBuffer(size);
    const dv  = new DataView(buf);

    // ── WAV 헤더 ──
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF');
    dv.setUint32(4, size - 8, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * ch * (bps / 8), true);
    dv.setUint16(32, ch * (bps / 8), true);
    dv.setUint16(34, bps, true);
    ws(36, 'data');
    dv.setUint32(40, data, true);

    // ── 샘플 생성 ──
    const MX = 32767;
    let p0=0, p1=0, p2=0, p3=0, p4=0, p5=0, p6=0;
    let brownL = 0, brownR = 0;
    let off = 44;

    for (let i = 0; i < len; i++) {
        const t = i / sr;
        let L = 0, R = 0;

        if (config.type === 'binaural') {
            const sL = Math.sin(2 * Math.PI * config.baseFreq * t) * BEAT.sineAmp;
            const sR = Math.sin(2 * Math.PI * (config.baseFreq + config.beatFreq) * t) * BEAT.sineAmp;
            const w = Math.random() * 2 - 1;
            p0 = 0.99886*p0 + w*0.0555179;
            p1 = 0.99332*p1 + w*0.0750759;
            p2 = 0.96900*p2 + w*0.1538520;
            p3 = 0.86650*p3 + w*0.3104856;
            p4 = 0.55000*p4 + w*0.5329522;
            p5 = -0.7616*p5 - w*0.0168980;
            const pinkVal = (p0+p1+p2+p3+p4+p5+p6+w*0.5362) * 0.11;
            p6 = w * 0.115926;
            const noise = pinkVal * BEAT.bgNoiseAmp;
            L = sL + noise;
            R = sR + noise;
        } else if (config.noiseKind === 'pink') {
            const w = Math.random() * 2 - 1;
            p0 = 0.99886*p0 + w*0.0555179;
            p1 = 0.99332*p1 + w*0.0750759;
            p2 = 0.96900*p2 + w*0.1538520;
            p3 = 0.86650*p3 + w*0.3104856;
            p4 = 0.55000*p4 + w*0.5329522;
            p5 = -0.7616*p5 - w*0.0168980;
            const pinkVal = (p0+p1+p2+p3+p4+p5+p6+w*0.5362) * 0.11;
            p6 = w * 0.115926;
            L = R = pinkVal * BEAT.noiseAmp;
        } else if (config.noiseKind === 'brown') {
            const wL = Math.random() * 2 - 1;
            const wR = Math.random() * 2 - 1;
            brownL = (brownL + wL * 0.02) * 0.998;
            brownR = (brownR + wR * 0.02) * 0.998;
            L = brownL * BEAT.noiseAmp * 8;
            R = brownR * BEAT.noiseAmp * 8;
        }

        L = Math.max(-1, Math.min(1, L)) * MX;
        R = Math.max(-1, Math.min(1, R)) * MX;
        dv.setInt16(off, L, true); off += 2;
        dv.setInt16(off, R, true); off += 2;
    }

    return new Blob([buf], { type: 'audio/wav' });
}

// ════════════════════════════════════════════════
//  Web Audio API — 틱 & 차임
// ════════════════════════════════════════════════

function playTick() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const t = audioCtx.currentTime;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(TICK.freq, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + TICK.decay);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(TICK.volume, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.001, t + TICK.decay);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + TICK.decay);
}

function playChime(phase) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const t = audioCtx.currentTime;
    (CHIME.freqs[phase] || [440]).forEach((freq) => {
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(CHIME.volume, t + 0.04);
        gain.gain.setValueAtTime(CHIME.volume, t + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, t + CHIME.decay);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + CHIME.decay);
    });
}

// ════════════════════════════════════════════════
//  수면 사운드 — Web Audio API (완전 무끊김 무한 루프)
// ════════════════════════════════════════════════

async function createAndPlayBeat() {
    const ctx    = ensureAudioCtx();
    const config = BEAT_TYPES[state.selectedBeat];

    // AudioWorklet 등록 시도 (실시간 노이즈 생성용)
    const hasWorklet = await registerNoiseWorklet(ctx);

    // 마스터 게인 노드 (전체 수면 사운드 볼륨 제어)
    sleepGainNode = ctx.createGain();
    sleepGainNode.gain.value = BEAT.breathVolume * getVolumeMultiplier();
    sleepGainNode.connect(ctx.destination);

    if (config.type === 'binaural') {
        // ── 바이노럴 비트: 좌/우 개별 오실레이터 ──
        const merger = ctx.createChannelMerger(2);

        const oscL  = ctx.createOscillator();
        const gainL = ctx.createGain();
        oscL.frequency.value = config.baseFreq;
        gainL.gain.value     = BEAT.sineAmp;
        oscL.connect(gainL).connect(merger, 0, 0);
        oscL.start();

        const oscR  = ctx.createOscillator();
        const gainR = ctx.createGain();
        oscR.frequency.value = config.baseFreq + config.beatFreq;
        gainR.gain.value     = BEAT.sineAmp;
        oscR.connect(gainR).connect(merger, 0, 1);
        oscR.start();

        merger.connect(sleepGainNode);
        sleepSourceNodes.push(oscL, oscR);

        // 배경 핑크 노이즈
        if (hasWorklet) {
            // 실시간 생성 (완전 무끊김)
            const noiseNode = createNoiseWorkletNode(ctx, 'pink', BEAT.bgNoiseAmp);
            noiseNode.connect(sleepGainNode);
            sleepSourceNodes.push(noiseNode);
        } else {
            // 폴백: 이중 버퍼 크로스페이드
            const noiseBuf = generateSeamlessNoiseBuffer(ctx, 'pink', BEAT.loopSec, BEAT.bgNoiseAmp);
            const noiseCtrl = createSeamlessNoiseLoop(ctx, noiseBuf, sleepGainNode);
            noiseLoopControllers.push(noiseCtrl);
        }

    } else {
        // ── 순수 노이즈 ──
        if (hasWorklet) {
            // 실시간 생성 (완전 무끊김)
            const noiseNode = createNoiseWorkletNode(ctx, config.noiseKind, BEAT.noiseAmp);
            noiseNode.connect(sleepGainNode);
            sleepSourceNodes.push(noiseNode);
        } else {
            // 폴백: 이중 버퍼 크로스페이드
            const noiseBuf = generateSeamlessNoiseBuffer(ctx, config.noiseKind, BEAT.loopSec, BEAT.noiseAmp);
            const noiseCtrl = createSeamlessNoiseLoop(ctx, noiseBuf, sleepGainNode);
            noiseLoopControllers.push(noiseCtrl);
        }
    }

    // 백그라운드 재생 보조 시작
    startBackgroundKeepAlive();
}

function checkSleepTime() {
    if (state.phase !== 'sleepbeat' || !state.sleepStart) return;

    const elapsed = Date.now() - state.sleepStart;
    const totalMs = BEAT.durationMin * 60 * 1000;

    if (elapsed >= totalMs) {
        stopAll();
        return;
    }

    // 마지막 1분: 볼륨 서서히 감소 (Web Audio 스케줄링 사용)
    const remaining = totalMs - elapsed;
    if (remaining < 60000 && sleepGainNode && audioCtx && audioCtx.state === 'running') {
        const targetVol = BEAT.sleepVolume * getVolumeMultiplier();
        const fadeRatio = remaining / 60000;
        const fadeVol = Math.max(0.001, fadeRatio * targetVol);
        const t = audioCtx.currentTime;
        sleepGainNode.gain.cancelScheduledValues(t);
        sleepGainNode.gain.setValueAtTime(sleepGainNode.gain.value, t);
        sleepGainNode.gain.linearRampToValueAtTime(fadeVol, t + 0.5);
    }
}

// ════════════════════════════════════════════════
//  호흡 가이드
// ════════════════════════════════════════════════

/** 준비 카운트다운 (5초) → 호흡 시작 */
function startBreathing() {
    state.phase = 'breathing';
    state.cycle = 0;
    switchView('breathing');

    // ── 준비 단계 ──
    $('cycle-label').textContent = '준비';
    $('breath-label').textContent = '준비하세요';
    $('countdown').textContent = '';

    const orb = $('breath-orb');
    orb.className = 'breath-orb';
    orb.style.transition = 'all 1s ease';

    const prepMessages = [
        { time: 0, msg: '준비하세요' },
        { time: 3, msg: '코로 호흡' },
        { time: 5, msg: null },  // 시작
    ];

    let elapsed = 0;
    const prepCountdown = () => {
        if (state.phase !== 'breathing') return;

        const remaining = 5 - elapsed;
        if (remaining > 0) {
            $('countdown').textContent = remaining;
            playTick();
        }

        // 메시지 업데이트
        const nextMsg = prepMessages.find(m => m.time === elapsed);
        if (nextMsg && nextMsg.msg) {
            $('breath-label').textContent = nextMsg.msg;
        }

        elapsed++;

        if (elapsed <= 5) {
            state.breathTimeout = setTimeout(prepCountdown, 1000);
        } else {
            // 준비 완료 → 첫 사이클 시작
            nextCycle();
        }
    };

    // 첫 메시지는 즉시, 카운트다운은 1초 후 시작
    state.breathTimeout = setTimeout(prepCountdown, 1000);
}

function nextCycle() {
    if (state.phase !== 'breathing') return;
    state.cycle++;
    if (state.cycle > state.selectedCycles) { transitionToSleepBeat(); return; }

    $('cycle-label').textContent = `${state.cycle} / ${state.selectedCycles} 사이클`;
    doPhase('inhale', BREATHING.inhale, () => {
        doPhase('hold', BREATHING.hold, () => {
            doPhase('exhale', BREATHING.exhale, nextCycle);
        });
    });
}

function doPhase(name, seconds, onDone) {
    if (state.phase !== 'breathing') return;

    playChime(name);

    const labels = { inhale: '들이마시기', hold: '참기', exhale: '내쉬기' };
    $('breath-label').textContent = labels[name];

    const orb = $('breath-orb');
    orb.style.transition =
        `transform ${seconds}s ease-in-out, ` +
        'background 0.6s ease, border-color 0.6s ease, box-shadow 0.8s ease';
    orb.className = `breath-orb ${name}`;

    let left = seconds;
    $('countdown').textContent = left;

    clearInterval(state.breathInterval);
    state.breathInterval = setInterval(() => {
        left--;
        if (left > 0) {
            $('countdown').textContent = left;
            playTick();
        } else if (left === 0) {
            $('countdown').textContent = '';
        }
    }, 1000);

    clearTimeout(state.breathTimeout);
    state.breathTimeout = setTimeout(() => {
        clearInterval(state.breathInterval);
        onDone();
    }, seconds * 1000);
}

// ════════════════════════════════════════════════
//  수면 사운드 전환
// ════════════════════════════════════════════════
function transitionToSleepBeat() {
    state.phase = 'sleepbeat';
    state.sleepStart = Date.now();

    // audioCtx는 유지 — 수면 사운드가 같은 컨텍스트를 사용 중

    const config = BEAT_TYPES[state.selectedBeat];
    $('sleep-beat-name').textContent = `${config.name} · ${config.desc}`;

    // GainNode로 부드러운 볼륨 전환 (2초)
    if (sleepGainNode && audioCtx) {
        const t = audioCtx.currentTime;
        sleepGainNode.gain.cancelScheduledValues(t);
        sleepGainNode.gain.setValueAtTime(sleepGainNode.gain.value, t);
        sleepGainNode.gain.linearRampToValueAtTime(
            BEAT.sleepVolume * getVolumeMultiplier(), t + 2
        );
    }

    // 30분 자동종료 타이머
    sleepTimerIv = setInterval(checkSleepTime, 1000);

    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Deep Sleep', artist: config.name + ' 재생 중',
        });
    }

    // 전체 볼륨 슬라이더 동기화 (드래그 중이 아니므로 전체 동기화)
    syncAllVolumeSliders();

    switchView('sleepbeat');
    updateRemaining();
}

// ════════════════════════════════════════════════
//  남은 시간
// ════════════════════════════════════════════════
function updateRemaining() {
    if (state.phase !== 'sleepbeat') return;
    const elapsed = Date.now() - state.sleepStart;
    const totalMs = BEAT.durationMin * 60 * 1000;
    const rem     = Math.max(0, totalMs - elapsed);
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    $('time-remaining').textContent = `${m}:${String(s).padStart(2, '0')}`;
    if (rem > 0) state.remainTimer = setTimeout(updateRemaining, 1000);
}

// ════════════════════════════════════════════════
//  메인 컨트롤
// ════════════════════════════════════════════════
async function startApp() {
    stopPreview();              // 미리듣기 정리
    await createAndPlayBeat();  // audioCtx + 수면 사운드 생성 (worklet 등록 대기)
    startBreathing();           // 틱/차임도 같은 audioCtx 사용
}

function stopAll() {
    const wasPhase = state.phase;
    state.phase = 'idle';
    clearInterval(state.breathInterval);
    clearTimeout(state.breathTimeout);
    clearTimeout(state.remainTimer);
    clearInterval(sleepTimerIv);
    sleepTimerIv = null;

    if (sleepGainNode) {
        if (wasPhase === 'sleepbeat') { fadeOutAndClean(); }
        else { cleanAudio(); }
    } else {
        if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
        switchView('idle');
        resetBreathUI();
    }
}

function fadeOutAndClean() {
    if (!sleepGainNode || !audioCtx) { cleanAudio(); return; }
    const t = audioCtx.currentTime;
    sleepGainNode.gain.cancelScheduledValues(t);
    sleepGainNode.gain.setValueAtTime(sleepGainNode.gain.value, t);
    sleepGainNode.gain.linearRampToValueAtTime(0, t + 1);   // 1초 페이드 아웃
    setTimeout(cleanAudio, 1100);
}

function cleanAudio() {
    // 소스 노드 정리
    sleepSourceNodes.forEach((node) => {
        try { node.stop(); } catch(e) {}
        try { node.disconnect(); } catch(e) {}
    });
    sleepSourceNodes = [];

    // 노이즈 루프 컨트롤러 정리
    noiseLoopControllers.forEach(ctrl => ctrl.stop());
    noiseLoopControllers = [];

    if (sleepGainNode) {
        try { sleepGainNode.disconnect(); } catch(e) {}
        sleepGainNode = null;
    }

    if (sleepTimerIv) {
        clearInterval(sleepTimerIv);
        sleepTimerIv = null;
    }

    if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
    }

    // 백그라운드 보조 정리
    stopBackgroundKeepAlive();

    switchView('idle');
    resetBreathUI();
}

// ════════════════════════════════════════════════
//  UI 헬퍼
// ════════════════════════════════════════════════
function switchView(name) {
    document.querySelectorAll('.view').forEach((el) => {
        el.classList.toggle('active', el.id === `${name}-view`);
    });
}

function resetBreathUI() {
    const orb = $('breath-orb');
    if (orb) { orb.className = 'breath-orb'; orb.style.transition = 'all 0.5s ease'; }
    if ($('breath-label'))  $('breath-label').textContent = '준비';
    if ($('countdown'))     $('countdown').textContent = '';
}

function updateHint() {
    const config = BEAT_TYPES[state.selectedBeat];
    const hint   = $('hint');
    hint.textContent = config.earphones
        ? '🎧 이 사운드는 이어폰 착용이 필수입니다'
        : '🔊 이 사운드는 스피커로도 효과가 있습니다';
}

function updateBeatSelection() {
    document.querySelectorAll('.beat-chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.beat === state.selectedBeat);
    });
    updateHint();
}

function updateCycleSelection() {
    document.querySelectorAll('.cycle-chip').forEach((chip) => {
        chip.classList.toggle('active', parseInt(chip.dataset.cycles) === state.selectedCycles);
    });
}

// 볼륨 아이콘 갱신 (최솟값이면 음소거 아이콘)
function updateVolIcons() {
    const leftIcon  = $('vol-icon-left');
    const sleepIcon = $('sleep-vol-icon-left');
    const breathIcon = $('breath-vol-icon-left');
    const icon = state.userVolume <= 1 ? '🔇' : '🔉';
    if (leftIcon)  leftIcon.textContent = icon;
    if (sleepIcon) sleepIcon.textContent = icon;
    if (breathIcon) breathIcon.textContent = icon;
}

// 전체 볼륨 슬라이더 동기화 (sourceId: 현재 드래그 중인 슬라이더 ID, 재설정 방지)
function syncAllVolumeSliders(sourceId) {
    const sliderIds = ['volume-slider', 'sleep-volume-slider', 'breath-volume-slider'];
    sliderIds.forEach(id => {
        if (id === sourceId) return; // 드래그 중인 슬라이더는 건드리지 않음
        const slider = $(id);
        if (slider) slider.value = state.userVolume;
    });
    updateVolIcons();
}

// rAF 기반 gain 업데이트 (렌더링 프레임과 동기화)
let _volumeRafId = null;
function scheduleGainUpdate() {
    if (_volumeRafId) return;
    _volumeRafId = requestAnimationFrame(() => {
        _volumeRafId = null;
        if (sleepGainNode && audioCtx && audioCtx.state === 'running') {
            const targetVol = (state.phase === 'breathing') ? BEAT.breathVolume : BEAT.sleepVolume;
            const newVal = targetVol * getVolumeMultiplier();
            sleepGainNode.gain.setValueAtTime(newVal, audioCtx.currentTime);
        }
    });
}

// 볼륨 변경 공통 로직 (sourceId: 현재 조작 중인 슬라이더 ID)
function handleVolumeChange(value, sourceId) {
    state.userVolume = Math.max(1, Math.min(100, parseInt(value) || 50));
    localStorage.setItem('userVolume', state.userVolume);

    scheduleGainUpdate();

    if (previewAudio) {
        previewAudio.volume = 0.45 * getVolumeMultiplier();
    }

    syncAllVolumeSliders(sourceId);
}

// 화면 복귀 시 타이머 갱신
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.phase === 'sleepbeat') {
        clearTimeout(state.remainTimer);
        updateRemaining();
    }
    // 화면 복귀 시 Wake Lock 재획득
    if (!document.hidden && wakeLock === null && state.phase !== 'idle') {
        if ('wakeLock' in navigator) {
            navigator.wakeLock.request('screen')
                .then(lock => { wakeLock = lock; })
                .catch(() => {});
        }
    }
});

// ════════════════════════════════════════════════
//  미리듣기 (3초 샘플)
// ════════════════════════════════════════════════
let previewAudio   = null;
let previewBlobUrl = null;
let previewTimeout = null;
let previewFadeIv  = null;

function playPreview(beatKey) {
    stopPreview();

    const blob = generateWAV(beatKey, 3);   // 3초짜리 미니 WAV
    previewBlobUrl = URL.createObjectURL(blob);

    previewAudio = new Audio(previewBlobUrl);
    previewAudio.volume = 0.45 * getVolumeMultiplier();
    previewAudio.play().catch(() => {});

    // 활성 칩에 재생 표시
    document.querySelectorAll('.beat-chip').forEach(c => c.classList.remove('playing'));
    const activeChip = document.querySelector(`.beat-chip[data-beat="${beatKey}"]`);
    if (activeChip) activeChip.classList.add('playing');

    // 2.3초 후 페이드 아웃 시작, 3초에 종료
    previewTimeout = setTimeout(() => {
        if (!previewAudio) return;
        previewFadeIv = setInterval(() => {
            if (!previewAudio) { clearInterval(previewFadeIv); return; }
            previewAudio.volume = Math.max(0, previewAudio.volume - 0.06);
            if (previewAudio.volume <= 0.01) {
                clearInterval(previewFadeIv);
                stopPreview();
            }
        }, 50);
    }, 2300);
}

function stopPreview() {
    if (previewAudio) {
        previewAudio.pause();
        previewAudio.src = '';
        previewAudio = null;
    }
    // Blob URL 메모리 해제
    if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = null;
    }
    clearTimeout(previewTimeout);
    clearInterval(previewFadeIv);
    previewTimeout = null;
    previewFadeIv  = null;
    document.querySelectorAll('.beat-chip').forEach(c => c.classList.remove('playing'));
}

// ════════════════════════════════════════════════
//  이벤트 바인딩
// ════════════════════════════════════════════════
$('start-btn').addEventListener('click', startApp);
$('stop-breath-btn').addEventListener('click', stopAll);
$('stop-sleep-btn').addEventListener('click', stopAll);

// 사운드 선택 + 미리듣기
$('beat-options').addEventListener('click', (e) => {
    const chip = e.target.closest('.beat-chip');
    if (!chip) return;
    state.selectedBeat = chip.dataset.beat;
    localStorage.setItem('selectedBeat', state.selectedBeat);
    updateBeatSelection();
    playPreview(state.selectedBeat);   // ← 3초 미리듣기
});

// 호흡 횟수 선택
$('cycle-options').addEventListener('click', (e) => {
    const chip = e.target.closest('.cycle-chip');
    if (!chip) return;
    state.selectedCycles = parseInt(chip.dataset.cycles);
    localStorage.setItem('selectedCycles', state.selectedCycles);
    updateCycleSelection();
});

// 모든 볼륨 슬라이더 이벤트 바인딩
['volume-slider', 'sleep-volume-slider', 'breath-volume-slider'].forEach(id => {
    const slider = $(id);
    if (slider) {
        slider.value = state.userVolume;
        slider.addEventListener('input', (e) => {
            handleVolumeChange(e.target.value, id);
        });
    }
});

// 초기 UI
updateBeatSelection();
updateCycleSelection();
updateVolIcons();

// ════════════════════════════════════════════════
//  오프라인 지원 (Service Worker)
// ════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .catch(() => {});
    });
}

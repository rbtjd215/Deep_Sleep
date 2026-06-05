# Deep_Sleep_app

본 프로젝트는 수면 유도를 위한 4-7-8 호흡 가이드 및 수면 사운드를 제공하는 웹 애플리케이션입니다. 
웹 기술만으로 네이티브 앱 수준의 백그라운드 재생을 지원하며, 오프라인 환경에서도 동작하도록 설계되었습니다.
*참고: 바이노럴 비트 사운드의 효과적인 청취를 위해 이어폰 또는 헤드폰 착용을 권장합니다.*

**[수면 앱 바로 가기](https://rbtjd215.github.io/Deep_Sleep_app/)**  
**[수면 앱 가이드 보기](GUIDE.md)**

---

## 1. 스크린샷 (Screenshots)
*(여기에 앱 실행 화면이나 호흡 애니메이션 GIF를 추가하세요)*

---

## 2. 시스템 아키텍처 (System Architecture)

본 애플리케이션은 오디오 제어와 백그라운드 환경을 제공하기 위해 아래와 같은 구조로 설계되었습니다.

```mermaid
graph TD
    UI[User Interface / DOM] --> |Control| AudioEngine[Web Audio API Engine]
    UI --> |State| PWA[PWA & Service Worker]
    
    subgraph AudioEngine [Web Audio API Engine]
        Worklet[AudioWorkletProcessor<br>실시간 노이즈 생성] --> Gain[마스터 GainNode]
        Osc[OscillatorNode<br>바이노럴 비트] --> Merger[ChannelMergerNode<br>좌우 분리] --> Gain
        Gain --> Dest[AudioDestination]
    end
    
    subgraph BackgroundControl [Background & OS Integration]
        Hack[Silent WAV Blob<br>백그라운드 미디어 세션 유지] --> OS[OS Media Session]
        Wake[Wake Lock API<br>화면 꺼짐 방지] --> OS
    end
    
    AudioEngine --> BackgroundControl
```

---

## 3. 핵심 기술 및 트러블슈팅 (Implementation & Troubleshooting)

### 3.1. 실시간 노이즈 오디오 생성 (Real-time Noise Generation)
* **문제 (Trouble):** 초기 구현에서는 `HTML5 Audio` 및 `Web Audio API`의 `AudioBufferSourceNode.loop = true` 속성을 사용하여 미리 생성된 노이즈 버퍼를 반복 재생했습니다. 그러나 브라우저 오디오 엔진의 특성상 반복 지점에서 미세한 간극(Gap)이 발생하여 수면 유도용 사운드에 적합하지 않은 끊김 현상이 발생했습니다.
* **해결 (Shooting):** 버퍼 반복 방식을 폐기하고, `AudioWorklet`을 도입하여 별도의 오디오 스레드에서 샘플 단위로 오디오 파형을 실시간 생성하도록 구조를 변경하여 루프 경계 자체를 없애고 끊김 현상을 원천 차단했습니다.
* **구현 상세:**
  * **Pink Noise:** Paul Kellet의 최적화 알고리즘을 적용하여 백색 소음에 여러 저주파 통과 필터를 직렬 연산해 1/f 특성을 구현했습니다.
  * **Brown Noise:** 좌우 채널을 분리하여 무작위 행보 누적(Random walk accumulation) 방식으로 묵직한 베이스 에너지를 유지합니다.

```javascript
class NoiseProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.kind = options.processorOptions.kind || 'pink';
        this.amp  = options.processorOptions.amplitude || 0.25;
        this.p = new Float64Array(7); // 핑크 노이즈 계수
        this.bL = 0; this.bR = 0;     // 브라운 노이즈 누적기
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        const outR = outputs[0][1];

        if (this.kind === 'pink') {
            for (let i = 0; i < outL.length; i++) {
                const w = Math.random() * 2 - 1;
                this.p[0] = 0.99886 * this.p[0] + w * 0.0555179;
                this.p[1] = 0.99332 * this.p[1] + w * 0.0750759;
                this.p[2] = 0.96900 * this.p[2] + w * 0.1538520;
                this.p[3] = 0.86650 * this.p[3] + w * 0.3104856;
                this.p[4] = 0.55000 * this.p[4] + w * 0.5329522;
                this.p[5] = -0.7616 * this.p[5] - w * 0.0168980;
                const val = (this.p[0]+this.p[1]+this.p[2]+this.p[3]+this.p[4]+this.p[5]+this.p[6]+w*0.5362) * 0.11 * this.amp;
                this.p[6] = w * 0.115926;
                outL[i] = outR[i] = val;
            }
        } else {
            for (let i = 0; i < outL.length; i++) {
                this.bL = (this.bL + (Math.random() * 2 - 1) * 0.02) * 0.998;
                this.bR = (this.bR + (Math.random() * 2 - 1) * 0.02) * 0.998;
                outL[i] = this.bL * this.amp * 8;
                outR[i] = this.bR * this.amp * 8;
            }
        }
        return true;
    }
}
```

### 3.2. 모바일 백그라운드 오디오 지속 (Background Audio Persistence)
* **문제 (Trouble):** 모바일 OS(특히 iOS) 특성상 사용자가 화면을 끄거나 앱을 백그라운드로 전환하면 브라우저의 오디오 컨텍스트가 즉각 중지되어 수면 사운드 재생이 끊기는 문제가 발생했습니다.
* **해결 (Shooting):** 자바스크립트로 1초 길이의 무음(Silent) WAV 파일을 바이너리(Blob) 레벨에서 직접 생성하고, 이를 보이지 않는 `<audio>` 태그에서 무한 반복 재생시켰습니다. 이를 통해 OS의 미디어 세션을 유지하여 백그라운드 재생이 끊기지 않도록 우회 구현했습니다.

```javascript
function createSilentWAV() {
    const sr = 22050, dur = 1, ch = 1, bps = 16;
    const len = sr * dur;
    const data = len * ch * (bps / 8);
    const size = 44 + data;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    const ws = (o, s) => { for (let i=0; i<s.length; i++) dv.setUint8(o+i, s.charCodeAt(i)); };
    
    ws(0, 'RIFF'); dv.setUint32(4, size - 8, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * (bps / 8), true);
    dv.setUint16(32, ch * (bps / 8), true); dv.setUint16(34, bps, true);
    ws(36, 'data'); dv.setUint32(40, data, true);
    
    return new Blob([buf], { type: 'audio/wav' });
}

// 생성된 Blob을 숨겨진 오디오 요소에 연결하여 무한 재생
silentBlobUrl = URL.createObjectURL(createSilentWAV());
silentAudio = new Audio(silentBlobUrl);
silentAudio.loop = true;
silentAudio.play();
```

### 3.3. 바이노럴 비트 엔진 (Binaural Beat Engine)
* **구현 상세:** 양쪽 귀에 미세하게 다른 주파수를 들려주어 뇌파 동조(Delta, Theta)를 유도합니다. `OscillatorNode` 2개와 `ChannelMergerNode`를 결합하여 좌우 채널을 물리적으로 엄격하게 분리했습니다. 예를 들어 왼쪽 귀에 100Hz, 오른쪽 귀에 103Hz를 출력하여 사용자가 두 주파수의 차이인 3Hz(델타파)를 내부적으로 합성해 인식하도록 구현했습니다.

```javascript
const merger = ctx.createChannelMerger(2);

// 왼쪽 채널 오실레이터 (기준 주파수 100Hz)
const oscL = ctx.createOscillator();
oscL.frequency.value = 100;
oscL.connect(ctx.createGain()).connect(merger, 0, 0);

// 오른쪽 채널 오실레이터 (기준 + 목표 뇌파 주파수 3Hz = 103Hz)
const oscR = ctx.createOscillator();
oscR.frequency.value = 100 + 3;
oscR.connect(ctx.createGain()).connect(merger, 0, 1);

merger.connect(sleepGainNode);
```

### 3.4. 오디오 제어 및 렌더링 최적화
* **페이드아웃 충돌 해결:** 수면 모드 종료 1분 전부터 서서히 소리가 줄어들도록(Fade-out) 타이머 기반으로 `gain.value`를 수동 조작했을 때, 사용자의 볼륨 조절과 상태가 충돌하는 문제가 있었습니다. 이를 Web Audio API의 스케줄링 메서드인 `linearRampToValueAtTime()`을 활용하여 오디오 엔진이 자체적으로 부드럽게 페이드아웃을 처리하도록 위임하여 해결했습니다.
* **슬라이더 렌더링 버그 수정:** 볼륨 슬라이더를 빠르게 조절할 때 동그라미(Thumb) UI가 이중으로 분리되거나 잔상이 남는 브라우저 렌더링 버그를 CSS `will-change: transform` 가속 힌트 추가와 이벤트 최적화로 해결했습니다.

---

## 4. 화면 제어 및 상태 동기화 (Wake Lock & Media Session)
* **Wake Lock API**: 호흡 가이드(4-7-8)를 따라 하는 동안 스마트폰 화면이 자동 절전모드로 꺼지는 것을 방지합니다. (`navigator.wakeLock.request('screen')`)
* **Media Session API**: 잠금 화면 및 알림창 컨트롤러에 현재 재생 중인 사운드 종류를 동기화하여, 네이티브 앱처럼 백그라운드 컨트롤이 가능하게 하였습니다.

---

## 5. 로컬 실행 방법 (Local Development)

본 프로젝트는 `AudioWorklet`과 `Service Worker`를 사용하므로, 브라우저 보안 정책상 로컬 파일 열기(`file://`) 방식으로는 정상 동작하지 않습니다.

1. 저장소를 클론합니다.
   ```bash
   git clone https://github.com/rbtjd215/Deep_Sleep.git
   ```
2. VSCode의 **Live Server** 확장 프로그램을 사용하거나, 터미널에서 로컬 서버를 실행합니다.
   ```bash
   npx serve .
   ```
3. 브라우저에서 서버 주소(예: `http://localhost:3000`)로 접속합니다.

---

## 6. PWA (Progressive Web App) 통합
* `manifest.json`: 앱 아이콘, 테마 색상, 독립형(Standalone) 모드를 지정하여 설치 시 브라우저 주소창을 제거합니다.
* `sw.js` (Service Worker): 핵심 자원(HTML, JS, CSS, 오디오 파일)을 브라우저 캐시에 저장하여 오프라인 환경에서도 안정적으로 동작합니다.

---

## 7. License
본 프로젝트는 MIT 라이선스 하에 배포됩니다.

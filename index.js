// ============================================================
//  Chzzk Hybrid Bot (Reader: Custom Logic / Sender: buzzk v1.11.3)
// ============================================================

const path = require('path');
// .exe로 빌드했을 때 외부의 .env 파일을 읽기 위해 process.cwd() 사용
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const fs = require('fs');
const mysql = require('mysql2/promise');
const axios = require('axios');
const WebSocket = require('ws');
const buzzk = require('buzzk'); // 반드시 v1.11.3 버전 사용

// === [환경 변수 로드 및 디버깅] ===
const CHZZK_CHANNEL_ID = process.env.CHZZK_CHANNEL_ID;
const NID_AUT = process.env.NID_AUT;
const NID_SES = process.env.NID_SES;
const WS_URL = "wss://kr-ss1.chat.naver.com/chat";

console.log('[Debug] DB_USER:', process.env.DB_USER);
console.log('[Debug] DB_PASSWORD:', process.env.DB_PASSWORD ? "****** (설정됨)" : "NULL (비어있음!)");

// 1. MySQL 연결 설정
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 2. 명령어(cheat.txt) 로드
const commandMap = new Map();
function loadCheatTxt() {
    try {
        // exe 외부의 파일을 읽기 위해 process.cwd() 사용
        const targetPath = path.join(process.cwd(), 'cheat.txt');
        const data = fs.readFileSync(targetPath, 'utf8');
        const lines = data.split(/\r?\n/);
        lines.forEach(line => {
            if (!line.trim()) return;
            const parts = line.split(';');
            if (parts.length >= 3) {
                // 키: #명령어
                const key = `${parts[0].trim()}${parts[1].trim()}`;
                // 값: 답변 (URL 등 세미콜론 포함 텍스트 잘림 방지)
                const value = parts.slice(2).join(';').trim();
                commandMap.set(key, value);
            }
        });
        console.log(`[System] cheat.txt 로드 완료 (${commandMap.size}개 명령어)`);
    } catch (e) { 
        console.error('[Warning] cheat.txt 파일을 찾을 수 없습니다.'); 
    }
}
loadCheatTxt();


// ============================================================
// [Part A] 입 (Sender): buzzk v1.11.3 라이브러리 사용
// ============================================================
let buzzkChat = null; // 전역 변수 (종료 함수 및 로직에서 접근)

async function initBuzzkSender() {
    console.log('[Sender] Buzzk(v1.11.3) 발신기 초기화 중...');
    try {
        await buzzk.login(NID_AUT, NID_SES);
        console.log('[Sender] 네이버 쿠키 로그인 성공');

        buzzkChat = new buzzk.chat(CHZZK_CHANNEL_ID);
        await buzzkChat.connect();
        console.log('[Sender] 채팅 발신 준비 완료');

    } catch (e) {
        console.error('[Sender Error] Buzzk 연결 실패:', e.message);
        console.log('-> 팁: NID_AUT/SES 만료 또는 buzzk 버전(1.11.3) 불일치 가능성 있음');
    }
}


// ============================================================
// [Part B] 눈 (Reader): Python 코드 로직 이식 (직접 통신)
// ============================================================
class PythonLogicReader {
    constructor() {
        this.ws = null;
        this.isRunning = true;
        this.reconnectCount = 0; // 재연결 시도 횟수 추적
    }

    // 모니터링 시작
    async run() {
        console.log(`[Reader] 모니터링 시작: ${CHZZK_CHANNEL_ID}`);
        this.loop();
    }

    // 무한 루프: 방송 상태 체크 -> 웹소켓 연결
    async loop() {
        while (this.isRunning) {
            try {
                // 재연결 시도 중임을 알리는 문구
                if (this.reconnectCount > 0) {
                    console.log(`\n[Reader] 🔄 웹소켓 재연결 시도 중... (시도 횟수: ${this.reconnectCount})`);
                }

                // 1. API: 방송 상태 확인
                const statusUrl = `https://api.chzzk.naver.com/polling/v2/channels/${CHZZK_CHANNEL_ID}/live-status`;
                const res = await axios.get(statusUrl, { timeout: 5000 });
                const content = res.data.content || {};
                
                if (content.status !== 'OPEN') {
                    console.log(`[Reader] 방송 종료 상태 (${content.status}). 10초 대기...`);
                    await this.sleep(10000);
                    continue;
                }

                // 2. API: 액세스 토큰 및 채팅방 ID 획득
                const chatChannelId = content.chatChannelId;
                const tokenUrl = `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`;
                const tokenRes = await axios.get(tokenUrl, { timeout: 5000 });
                const accessToken = tokenRes.data.content.accessToken;

                // 3. WS: 웹소켓 연결 및 대기
                await this.connectWebSocket(chatChannelId, accessToken);
                
                // WS 연결이 끊어지면 아래 코드가 실행되며 루프 재시작
                if (this.isRunning) {
                    console.log('\n[Reader] ⚠️ 웹소켓 연결이 끊어졌습니다. 3초 후 재접속 프로세스를 시작합니다...');
                    this.reconnectCount++; // 다음 루프는 재연결로 간주
                }

            } catch (e) {
                if (!this.isRunning) break;
                // 접속 및 API 에러 발생 시
                console.error(`\n[Reader] ❌ 재연결(접속) 실패: ${e.message}`);
                console.log(`[Reader] 10초 후 다시 시도합니다... (누적 시도: ${this.reconnectCount + 1})\n`);
                this.reconnectCount++;
                await this.sleep(10000);
            }
        }
    }

    // 웹소켓 연결 관리
    connectWebSocket(chatChannelId, accessToken) {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(WS_URL);

            this.ws.on('open', () => {
                // 연결 성공 시 로그 처리
                if (this.reconnectCount > 0) {
                    console.log(`[Reader] ✅ 웹소켓 재연결 성공! 정상 모니터링을 재개합니다.`);
                    this.reconnectCount = 0; // 성공 시 카운트 초기화
                } else {
                    console.log(`[Reader] WS 최초 연결 성공 -> 핸드쉐이크 전송`);
                }

                const packet = {
                    ver: "2", cmd: 100, svcid: "game", cid: chatChannelId, tid: 1,
                    bdy: { uid: null, devType: 2001, accTkn: accessToken, auth: "READ" }
                };
                this.ws.send(JSON.stringify(packet));
            });

            this.ws.on('message', async (raw) => {
                try {
                    const data = JSON.parse(raw.toString());
                    this.handlePacket(data);
                } catch (e) { console.error('[Reader] 파싱 에러', e); }
            });

            this.ws.on('close', () => {
                this.cleanup();
                // 3초 후 Promise를 resolve하여 loop()가 다시 돌게 함
                setTimeout(() => resolve(), 3000);
            });

            this.ws.on('error', (err) => {
                console.error('[Reader] WS 에러:', err.message);
                this.cleanup();
            });
        });
    }

    // 패킷 처리 로직
    async handlePacket(data) {
        const cmd = data.cmd;

        // PING(0) -> PONG(10000) (연결 유지)
        if (cmd === 0) {
            this.ws.send(JSON.stringify({ ver: "2", cmd: 10000 }));
            return;
        }

        // 채팅 메시지 수신 (cmd 93101)
        if (cmd === 93101) {
            const bdy = data.bdy || [];
            for (const chat of bdy) {
                if (chat.msgStatusType === 'hidden') continue; // 클린봇 등 무시

                const rawMsg = chat.msg || '';
                let profile = {};
                try { profile = JSON.parse(chat.profile); } catch(e) {}
                const nickname = profile.nickname || '익명';
                const msg = rawMsg.trim();

                if (!msg) continue;

                // 로그 출력
                console.log(`[Chat] ${nickname}: ${msg}`);

                // *** 핵심 비즈니스 로직 실행 ***
                await processLogic(msg);
            }
        }
    }

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws = null;
        }
    }

    stop() {
        this.isRunning = false;
        if (this.ws) this.ws.close();
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}


// ============================================================
// [Part C] 뇌 (Logic): 비즈니스 로직 처리
// ============================================================
async function processLogic(msg) {
    // 발신기가 준비되지 않았으면 로직 수행 안함
    if (!buzzkChat) return;

    // [기능 1] ?글자 : DB 조회
    if (msg.startsWith('?')) {
        const char = msg.substring(1).trim();
        if (char) {
            try {
                // SQL: can_use가 1(true)인 단어 카운트
                const sql = "SELECT count(*) as cnt FROM ko_word WHERE start_char = ? AND can_use = true";
                const [rows] = await pool.execute(sql, [char]);
                const count = rows[0].cnt;
                
                const reply = `[DB검색] '${char}'(으)로 시작하는 단어: ${count}개`;
                console.log(` -> 답변 전송 시도: ${reply}`);
                await buzzkChat.send(reply);

            } catch (err) {
                console.error('[Logic] DB Error:', err.message);
            }
        }
    }

    // [기능 2] #단어 : 매크로 (cheat.txt)
    else if (msg.startsWith('#')) {
        if (commandMap.has(msg)) {
            const reply = commandMap.get(msg);
            console.log(` -> 매크로 응답 시도: ${reply}`);
            // https:// 가 포함된 텍스트는 채팅창에서 자동으로 링크 변환됨
            await buzzkChat.send(reply);
        }
    }
}


// ============================================================
// [Part D] 시스템 종료 처리 (Ctrl + C)
// ============================================================
let globalReader = null;

async function handleShutdown() {
    console.log('\n\n[System] 종료 신호(SIGINT) 감지. 정리 작업 시작...');

    // 1. 종료 메시지 전송
    if (buzzkChat) {
        try {
            console.log('[System] 종료 메시지 전송 중...');
            await buzzkChat.send("끝말잇기 채팅 봇 종료");
        } catch (e) {
            console.error('[System] 메시지 전송 실패:', e.message);
        }
    }

    // 2. 리더 정지
    if (globalReader) {
        globalReader.stop();
        console.log('[System] 모니터링 정지 완료.');
    }

    // 3. DB 연결 해제
    try {
        await pool.end();
        console.log('[System] DB 연결 해제 완료.');
    } catch (e) {}

    console.log('[System] 봇이 안전하게 종료되었습니다.');
    process.exit(0);
}

// 이벤트 리스너 등록
process.on('SIGINT', handleShutdown);


// ============================================================
// [Main] 실행 진입점
// ============================================================
async function main() {
    try {
        console.log('=== [치지직 봇] 하이브리드 시스템 시작 ===');
        console.log('종료하려면 터미널에서 Ctrl + C를 누르세요.\n');

        // 1. 발신기(Sender) 준비
        await initBuzzkSender();

        if (buzzkChat) {
            // 연결 성공 시 안내 메시지 (기존 요청 반영)
            await buzzkChat.send("끝말잇기 봇 연결 완료");
        }

        // 2. 수신기(Reader) 가동
        globalReader = new PythonLogicReader();
        globalReader.run();

    } catch (e) {
        console.error('[Main] 치명적 오류 발생:', e);
        process.exit(1);
    }
}

main();
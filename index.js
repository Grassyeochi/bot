// ============================================================
//  Chzzk Hybrid Bot (Final Version)
//  Updated: 2026-02-19 (SQL Query Update: is_use = false)
// ============================================================

const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const axios = require('axios');
const WebSocket = require('ws');
const buzzk = require('buzzk');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const readline = require('readline');

// === [전역 상태 변수] ===
let isPaused = false;      // true면 로직 정지
let isRestarting = false;  // 재시작 프로세스 진행 중 여부
let pool = null;           // DB Connection Pool
let buzzkChat = null;      // Buzzk Chat Instance
let globalReader = null;   // Reader Instance
let mailTransporter = null;// Mail Transporter

// === [설정 변수 (재시작 시 갱신됨)] ===
let CONFIG = {
    CHZZK_CHANNEL_ID: '',
    NID_AUT: '',
    NID_SES: '',
    SMTP: {},
    MAIL_TO: ''
};

// === [초기 환경 설정 로드 함수] ===
function loadEnvironmentConfig() {
    try {
        const envPath = path.join(process.cwd(), '.env');
        const envConfig = dotenv.parse(fs.readFileSync(envPath));
        
        // process.env 업데이트
        for (const k in envConfig) {
            process.env[k] = envConfig[k];
        }

        CONFIG.CHZZK_CHANNEL_ID = process.env.CHZZK_CHANNEL_ID;
        CONFIG.NID_AUT = process.env.NID_AUT;
        CONFIG.NID_SES = process.env.NID_SES;
        CONFIG.MAIL_TO = process.env.SMTP_TO;
        CONFIG.SMTP = {
            host: process.env.SMTP_HOST || 'smtp.naver.com',
            port: parseInt(process.env.SMTP_PORT || '465'),
            secure: true,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        };

        console.log('[System] 환경 설정(.env) 로드 완료');
    } catch (e) {
        console.error('[System] .env 로드 실패:', e);
    }
}
loadEnvironmentConfig();


// === [기능 1: 메일 및 알림 시스템] ===
function initMailTransporter() {
    mailTransporter = nodemailer.createTransport(CONFIG.SMTP);
}
initMailTransporter();

async function sendAlertEmail(subject, errorMessage) {
    if (!CONFIG.MAIL_TO) return;
    
    const mailOptions = {
        from: CONFIG.SMTP.auth.user,
        to: CONFIG.MAIL_TO,
        subject: `[치지직 봇 긴급 알림] ${subject}`,
        text: `[봇 상태 보고]\n시간: ${new Date().toLocaleString()}\n내용:\n${errorMessage}\n\n※ 봇이 일시 정지되었습니다. 콘솔에 'restart'를 입력하여 재개하십시오.`
    };

    try {
        await mailTransporter.sendMail(mailOptions);
        console.log(`[Mail] 경고 메일 발송 성공: "${subject}"`);
    } catch (e) {
        console.error('[Mail] 메일 발송 실패:', e.message);
    }
}

// [New] 연결 종료 메시지 전송 헬퍼
async function trySendGoodbye() {
    // 채팅 객체가 있고 연결된 상태일 때만 시도
    if (buzzkChat) {
        try {
            console.log('[System] 종료 메시지 전송 시도...');
            await buzzkChat.send("끝말잇기 봇 연결 종료");
        } catch (e) {
            // 쿠키 만료나 네트워크 단절 시에는 조용히 실패함
            console.error('[System] 종료 메시지 전송 실패 (연결 불가):', e.message);
        }
    }
}

// 시스템 일시 정지
async function pauseSystem(reason, errorDetail) {
    if (isPaused || isRestarting) return;
    
    // 멈추기 전에 종료 메시지 전송 시도
    await trySendGoodbye();
    
    isPaused = true;
    
    console.error(`\n!!!! [SYSTEM PAUSED] !!!!`);
    console.error(`사유: ${reason}`);
    console.error(`상세: ${errorDetail}`);
    console.error(`조치: 모든 작업을 중단합니다. 재가동하려면 콘솔에 'restart'를 입력하세요.`);

    await sendAlertEmail(reason, errorDetail);
}

// 메모리 누수 등으로 인한 강제 종료
async function terminateSystem(reason, errorDetail) {
    await trySendGoodbye(); // 종료 메시지 시도
    
    isPaused = true;
    await sendAlertEmail(`[치명적] ${reason} - 종료됨`, errorDetail);
    console.log('[System] 3초 후 프로세스를 종료합니다...');
    setTimeout(() => { process.exit(1); }, 3000);
}

// 메모리 감시
const MEMORY_LIMIT_MB = 500; 
setInterval(async () => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    if (used > MEMORY_LIMIT_MB) {
        const msg = `메모리 초과(${Math.round(used)}MB). 강제 종료합니다.`;
        terminateSystem('메모리 누수 - 종료', msg);
    }
}, 30000);


// === [기능 2: 명령어(cheat.txt) 로드] ===
const commandMap = new Map();
function loadCheatTxt() {
    commandMap.clear();
    try {
        const data = fs.readFileSync(path.join(process.cwd(), 'cheat.txt'), 'utf8');
        const lines = data.split(/\r?\n/);
        lines.forEach(line => {
            if (!line.trim()) return;
            const parts = line.split(';');
            if (parts.length >= 3) {
                const key = `${parts[0].trim()}${parts[1].trim()}`;
                const value = parts.slice(2).join(';').trim();
                commandMap.set(key, value);
            }
        });
        console.log(`[System] cheat.txt 로드 완료 (${commandMap.size}개 명령어)`);
    } catch (e) { console.error('[Warning] cheat.txt 로드 실패'); }
}


// === [기능 3: DB 연결 관리] ===
async function initDB() {
    if (pool) {
        try { await pool.end(); } catch(e) {}
    }
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
    console.log('[System] DB 연결 풀 재설정 완료');
}


// === [기능 4: 리스타트(Soft Restart) 로직] ===
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.on('line', async (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'restart') {
        await restartSystem();
    }
});

async function restartSystem() {
    if (isRestarting) return;
    isRestarting = true;
    isPaused = true; 

    console.log('\n=== [System] 수동 재시작 프로세스 가동 ===');

    try {
        if (globalReader) {
            console.log('[Restart] 기존 모니터링 중단...');
            globalReader.stop();
            globalReader = null;
        }

        loadEnvironmentConfig();
        initMailTransporter();
        loadCheatTxt();
        await initDB();

        // Sender 재연결
        await initBuzzkSender();

        // 재시작 성공 시 메시지 전송
        if (!isPaused && buzzkChat) {
            try {
                await buzzkChat.send("끝말잇기 봇 연결 완료");
                console.log('[System] 재시작 완료 메시지 전송함');
            } catch (e) {
                console.error('[System] 재시작 메시지 전송 실패:', e.message);
            }
        }

        // Reader 재가동
        if (!isPaused) {
            globalReader = new PythonLogicReader();
            globalReader.run();
        }

        console.log('=== [System] 시스템이 성공적으로 재시작되었습니다. ===\n');

    } catch (e) {
        console.error('[Restart Error] 재시작 중 치명적 오류:', e);
        isPaused = true; 
    } finally {
        isRestarting = false;
    }
}


// === [Part A: Sender (Buzzk)] ===
async function initBuzzkSender() {
    console.log('[Sender] Buzzk 초기화/재로그인 시도...');
    try {
        await buzzk.login(CONFIG.NID_AUT, CONFIG.NID_SES);
        console.log('[Sender] 로그인 성공');

        buzzkChat = new buzzk.chat(CONFIG.CHZZK_CHANNEL_ID);
        await buzzkChat.connect();
        console.log('[Sender] 연결 완료');
        
        isPaused = false; 

    } catch (e) {
        console.error('[Sender Error]', e.message);
        // 로그인 실패 시 메시지를 보낼 수 없으므로 trySendGoodbye 호출 안 함
        // 바로 pauseSystem 호출
        await pauseSystem('재시작/로그인 실패', `로그인 불가. 에러: ${e.message}`);
    }
}


// === [Part B: Reader] ===
class PythonLogicReader {
    constructor() {
        this.ws = null;
        this.isRunning = true;
    }

    async run() {
        console.log(`[Reader] 모니터링 시작: ${CONFIG.CHZZK_CHANNEL_ID}`);
        this.loop();
    }

    async loop() {
        while (this.isRunning) {
            if (isPaused) { await this.sleep(2000); continue; }

            try {
                const statusUrl = `https://api.chzzk.naver.com/polling/v2/channels/${CONFIG.CHZZK_CHANNEL_ID}/live-status`;
                const res = await axios.get(statusUrl, { timeout: 5000 });
                const content = res.data.content || {};
                
                if (content.status !== 'OPEN') {
                    console.log(`[Reader] 방송 종료 상태. 10초 대기...`);
                    await this.sleep(10000);
                    continue;
                }

                const chatChannelId = content.chatChannelId;
                const tokenUrl = `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`;
                const tokenRes = await axios.get(tokenUrl, { timeout: 5000 });
                const accessToken = tokenRes.data.content.accessToken;

                await this.connectWebSocket(chatChannelId, accessToken);
                
                if (this.isRunning && !isPaused) console.log('[Reader] WS 재접속 시도...');

            } catch (e) {
                if (!this.isRunning) break;
                console.error(`[Reader] 통신 오류: ${e.message}. 10초 대기`);
                await this.sleep(10000);
            }
        }
    }

    connectWebSocket(chatChannelId, accessToken) {
        return new Promise((resolve, reject) => {
            if (isPaused) { resolve(); return; }
            
            // WebSocket URL
            this.ws = new WebSocket("wss://kr-ss1.chat.naver.com/chat");

            this.ws.on('open', () => {
                const packet = {
                    ver: "2", cmd: 100, svcid: "game", cid: chatChannelId, tid: 1,
                    bdy: { uid: null, devType: 2001, accTkn: accessToken, auth: "READ" }
                };
                this.ws.send(JSON.stringify(packet));
            });

            this.ws.on('message', async (raw) => {
                if (isPaused) return; 
                try {
                    const data = JSON.parse(raw.toString());
                    this.handlePacket(data);
                } catch (e) {}
            });

            this.ws.on('close', () => {
                this.cleanup();
                setTimeout(() => resolve(), 3000);
            });

            this.ws.on('error', (err) => {
                this.cleanup();
                resolve(); 
            });
        });
    }

    async handlePacket(data) {
        const cmd = data.cmd;
        if (cmd === 0) {
            this.ws.send(JSON.stringify({ ver: "2", cmd: 10000 }));
            return;
        }
        if (cmd === 93101) {
            const bdy = data.bdy || [];
            for (const chat of bdy) {
                if (chat.msgStatusType === 'hidden') continue;
                const rawMsg = chat.msg || '';
                const msg = rawMsg.trim();
                if (!msg) continue;
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
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}


// === [Part C: Logic] ===
async function processLogic(msg) {
    if (isPaused || !buzzkChat) return;

    if (msg.startsWith('?')) {
        const char = msg.substring(1).trim();
        if (char.length === 1) {
            try {
                // [수정] is_use = false 조건 적용
                const sql = "SELECT count(*) as cnt FROM ko_word WHERE start_char = ? AND is_use = false AND can_use = true AND available = true";
                const [rows] = await pool.execute(sql, [char]);
                const count = rows[0].cnt;
                
                const reply = `[DB] '${char}'(으)로 시작하는 단어: ${count}개`;
                console.log(` -> 답변: ${reply}`);
                await buzzkChat.send(reply);

            } catch (err) {
                console.error('[Logic Error]', err.message);
                if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNREFUSED') {
                    await pauseSystem('DB 연결 끊김', err.message);
                }
            }
        }
    }
    else if (msg.startsWith('#')) {
        if (commandMap.has(msg)) {
            const reply = commandMap.get(msg);
            console.log(` -> 매크로: ${reply}`);
            await buzzkChat.send(reply);
        }
    }
}


// === [Part D: Main Entry] ===
async function main() {
    try {
        console.log('=== [치지직 봇] 스마트 가드 v4 (DB 쿼리 수정됨) ===');
        console.log('명령어: "restart" 입력 시 설정을 새로고침하고 재시작합니다.\n');

        loadCheatTxt();
        await initDB();
        await initBuzzkSender();

        if (!isPaused) {
            if (buzzkChat) await buzzkChat.send("끝말잇기 봇 연결 완료");
            globalReader = new PythonLogicReader();
            globalReader.run();
        }

    } catch (e) {
        console.error('[Main] 초기화 실패:', e);
    }
}

main();

// === [Global Exception Handlers] ===
process.on('uncaughtException', async (err) => {
    await pauseSystem('알 수 없는 예외(Uncaught)', err.stack);
});
process.on('unhandledRejection', async (reason) => {
    await pauseSystem('프로미스 거부(Unhandled)', reason);
});
process.on('SIGINT', async () => {
    console.log('\n[System] 종료 신호 감지.');
    await trySendGoodbye(); // 종료 전 메시지 전송 시도
    if (pool) try { await pool.end(); } catch(e){}
    process.exit(0);
});
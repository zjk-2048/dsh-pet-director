#!/usr/bin/env node
/**
 * 桌宠「导演」—— 旁听桌宠对话，把对话意图翻译成动作点播。
 *
 * 设计原则（方案 B）：
 *   - 不修改 dsh-pet 的任何文件，只走它公开的点播接口 POST /dsh-pet-7340/anim；
 *   - 只读 ~/.dsh/dsh-pet/memory.json（宿主自己写的对话记忆，含用户原话 + 回复）；
 *   - 任何一步失败都只是「这次不动作」，绝不影响宠物本身；
 *   - 动作名全部来自配置里的真实动画池（白名单），不认识的绝不发送。
 *
 * 用法：
 *   node director.mjs                     # 自动探测 DSH 端口，常驻
 *   node director.mjs --port 59400        # 指定端口
 *   node director.mjs --dry               # 常驻但只打印判定，不发请求
 *   node director.mjs --test "吃个西瓜"    # 单条离线测试：只跑判定，不聊天、不发请求
 *   node director.mjs --selftest          # 全量自检：每条别名都必须命中自己的动画
 */

import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const DRY = argv.includes('--dry');
const TEST = arg('test', '');
const SELFTEST = argv.includes('--selftest');
const PET = arg('pet', 'main');
// $DSH_HOME 优先（DSH 自己会设），否则按平台回落到用户目录下的 .dsh
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh');
const MEMORY = arg('memory', join(DSH_HOME, 'dsh-pet', 'memory.json'));
const PORT_ARG = Number(arg('port', '0')) || 0;
const POLL_MS = Number(arg('poll', '700'));
const COOLDOWN_MS = Number(arg('cooldown', '2500'));
const MAX_AGE_MS = Number(arg('maxage', '60000'));

const log = (...a) => console.log(`[director ${new Date().toTimeString().slice(0, 8)}]`, ...a);

// ---------------- 动作目录 ----------------
// 键 = 配置里的真实动画名（必须逐字一致，否则 /anim 会拒绝）；
// 值 = 用户可能说的关键词。动画名本身、以及去掉「原地/小幅度/点击回应-」的核心词会自动加入。
// 覆盖范围：除下面明确排除的系统动画外，配置里所有动作。
//   排除：待机呼吸休闲 / 被鼠标拖拽悬空反馈（状态类）、余额-*（余额档位）、
//         碎碎念-*、工作状态-*（宿主自动触发的演出）——手动点播没有意义。
const CATALOG = {
  // —— 点击回应（情绪表情）——
  '点击回应-开心跃动': ['开心', '高兴', '好耶', '太棒了', '好开心'],
  '点击回应-害羞惊讶': ['害羞', '脸红', '不好意思'],
  '点击回应-傲娇生气': ['生气', '哼', '讨厌', '傲娇', '不开心'],
  '点击回应-挠痒咯咯笑': ['挠痒', '好痒', '笑一个', '逗我笑'],
  '点击回应-元气挥手': ['打招呼', '你好', '嗨', 'hello', '在吗', '挥挥手'],
  // —— 转向 / 移动 ——
  东张西望: ['东张西望', '四处看看', '看看四周'],
  螃蟹走路: ['螃蟹', '横着走', '螃蟹步'],
  原地漂浮踏步: ['踏步', '原地踏步', '漂浮'],
  原地左转奔跑: ['跑步', '跑一段', '跑两步', '跑起来'],
  // —— 小动作 ——
  悠闲哼歌: ['哼歌', '唱个歌', '唱歌'],
  超大伸懒腰: ['伸懒腰', '伸个懒腰', '伸展'],
  原地敲击桌面互动: ['敲桌子', '敲桌面', '敲敲'],
  原地重力下蹲压缩: ['下蹲', '蹲下', '蹲一个'],
  哈欠连天: ['哈欠', '困了', '想睡'],
  原地小憩沉眠: ['睡觉', '睡一会', '打个盹', '小憩', '晚安'],
  女仆屈膝礼仪: ['行礼', '鞠躬', '屈膝礼', '女仆礼'],
  被吓一跳: ['吓一跳', '吓我', '吓唬'],
  小幅度原地360度旋转展示: ['转圈', '转个圈', '旋转', '转一下', '转起来'],
  偷吃零食被抓住: ['偷吃'],
  用鲸鱼尾巴拍打地面: ['尾巴', '拍地'],
  打瞌睡被惊醒: ['惊醒', '打瞌睡'],
  照镜子: ['照镜子', '镜子'],
  整体换装试色: ['换装', '换衣服', '试色'],
  轻快记录: ['记录', '记一下'],
  写代码: ['写代码', '敲代码', '编程', '代码'],
  摇扇纳凉: ['扇子', '扇风', '纳凉'],
  晨间刷牙: ['刷牙'],
  // —— 玩耍 ——
  原地专心玩魔方: ['魔方'],
  原地蹲下玩玩具汽车: ['玩具车', '小汽车', '玩车'],
  鲸鱼吐泡泡特效: ['泡泡', '吐泡泡'],
  原地跳跃抓碎头顶物品: ['跳起来', '跳一下', '抓头顶'],
  玩游戏气急败坏: ['玩游戏', '打游戏', '游戏输了'],
  玩水枪: ['水枪', '滋水'],
  小提琴演奏: ['小提琴', '拉琴', '演奏'],
  蓝鲸现世: ['蓝鲸', '变身'],
  优雅女仆舞: ['女仆舞'],
  轻快摇摆舞: ['摇摆舞', '摇摆'],
  可爱宅舞: ['跳舞', '跳个舞', '宅舞', '来段舞'],
  吹气球: ['气球', '吹气球'],
  动物环绕: ['小动物', '动物'],
  放风筝: ['风筝', '放风筝'],
  拆礼物: ['礼物', '拆礼物'],
  变鸽子: ['鸽子', '变魔术'],
  扑克魔术: ['扑克', '纸牌', '扑克牌'],
  抽陀螺: ['陀螺'],
  吹笛子: ['笛子', '吹笛'],
  蝴蝶蜜蜂环绕头顶开花: ['蝴蝶', '蜜蜂', '开花'],
  撸猫: ['撸猫', '猫猫', '小猫'],
  凭空生花: ['生花', '变花'],
  骑木马: ['木马', '骑木马'],
  三球抛接: ['抛球', '杂耍', '三球'],
  踢毽子: ['毽子', '踢毽'],
  下五子棋: ['五子棋', '下棋'],
  荡秋千: ['秋千', '荡秋千'],
  // —— 吃什么 ——
  吃白饭: ['吃饭', '吃白饭', '干饭', '饿了'],
  大口吃零食: ['零食', '薯片', '吃零食'],
  吃Token: ['token', '吃token', '吃代币'],
  吃早餐: ['早餐', '早饭'],
  吃午餐: ['午餐', '午饭'],
  吃晚餐: ['晚餐', '晚饭'],
  吃冰淇淋融化: ['冰淇淋', '雪糕', '冰激凌'],
  吃大闸蟹: ['大闸蟹', '大螃蟹', '蟹'],
  吃糖葫芦: ['糖葫芦'],
  吃长寿面: ['长寿面', '面条', '吃面'],
  吃西瓜: ['西瓜'],
  涮火锅: ['火锅', '涮锅'],
  // —— 时节 ——
  被落叶淹没: ['落叶', '秋天'],
  中秋赏月吃月饼: ['月饼', '中秋'],
  堆雪人: ['雪人', '堆雪人', '下雪'],
  放烟花: ['烟花', '放烟花'],
  吃粽子: ['粽子', '端午'],
  吃年糕: ['年糕'],
  吃青团: ['青团'],
  吃腊八粥: ['腊八粥', '腊八'],
  吃重阳糕: ['重阳糕', '重阳'],
  收红包: ['红包', '压岁钱'],
  写福字: ['福字', '写福'],
  穿针乞巧: ['穿针', '乞巧'],
  舞狮头: ['舞狮', '狮子'],
  讨糖南瓜灯: ['南瓜灯', '万圣节', '讨糖'],
  插茱萸赏菊: ['茱萸', '赏菊', '菊花'],
  放河灯: ['河灯'],
  萌化小幽灵: ['幽灵', '小鬼'],
  装点圣诞树: ['圣诞树', '圣诞节', '圣诞'],
  放孔明灯: ['孔明灯', '天灯'],
  吃汤圆: ['汤圆', '元宵'],
  吃饺子: ['饺子', '吃饺'],
  // —— 文字类 ——
  '是啊，吃什么': ['是啊吃什么', '吃什么'],
  深度思考碎碎念: ['深度思考', '思考一下'],
};

// 真实位移的动画（moves.actions 成员），方向由 facing 决定
const MOVE_ANIMS = new Set(['螃蟹走路', '原地漂浮踏步', '原地左转奔跑']);

/** 一个动画名的所有可匹配键：名字本身 + 去前缀的核心词 + 手写别名 */
function keysOf(name, aliases) {
  const keys = new Set([name]);
  const stripped = name.replace(/^(点击回应-|余额-|碎碎念-|工作状态-)/, '');
  keys.add(stripped);
  keys.add(stripped.replace(/^原地/, '').replace(/^小幅度/, ''));
  for (const a of aliases) keys.add(a);
  return [...keys].filter((k) => k.length >= 2);
}

/** 扁平化成 [键, 动画名]，按键长倒序——长键优先，避免「螃蟹」抢在「大闸蟹」前面 */
const RULES = Object.entries(CATALOG)
  .flatMap(([name, aliases]) => keysOf(name, aliases).map((k) => ({ k, name })))
  .sort((a, b) => b.k.length - a.k.length);

const DIR = {
  left: /向左|往左|左边|左面|朝左|左转/,
  right: /向右|往右|右边|右面|朝右|右转/,
  motion: /(跑|走|移动|挪|过去|过来)/,
};

// ---------------- 2D 移动（阶段一：滑行）----------------
// 落地角色只有 1D 走路，纵向/斜向没有对应动画，所以走 /position 的 line 模式平移过去，
// 同时**尽量**先点播一个现有的移动动画（上下用「漂浮踏步」、斜向用「螃蟹走路」），
// 让它是"边走边挪"而不是纯滑行。位置系统接管时会停掉走路循环，但动画本身会继续播。
//
// 速度/步长放在 settings.json 里，**每次移动都重读**——改完不用重启导演，直接再跟它说一句就行。
//   glideMs ：滑行总时长（位移本身要花的时间）
//   leadMs  ：前摇——动画起播后先等这么久再开始位移，避开动作开头的准备帧
const SETTINGS_FILE = `${import.meta.dirname}\\settings.json`;
const DEFAULT_SETTINGS = {
  glideMs: 8000,
  leadMs: 300,
  stepX: 0.16,
  stepY: 0.12,
  balancePersona: true,
  balanceSyncMs: 60000,
};
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const n = (v, def, min) => (Number.isFinite(Number(v)) && Number(v) > min ? Number(v) : def);
    settings = {
      glideMs: n(raw.glideMs, DEFAULT_SETTINGS.glideMs, 200),
      leadMs: n(raw.leadMs, DEFAULT_SETTINGS.leadMs, -1), // 0 = 不等前摇
      stepX: n(raw.stepX, DEFAULT_SETTINGS.stepX, 0.01),
      stepY: n(raw.stepY, DEFAULT_SETTINGS.stepY, 0.01),
      // 余额写进人设：默认开；写 false 可关掉
      balancePersona: raw.balancePersona !== false,
      balanceSyncMs: n(raw.balanceSyncMs, DEFAULT_SETTINGS.balanceSyncMs, 5000),
    };
  } catch {
    // 文件不存在 / 写坏了 → 直接用默认值，绝不让调参把功能搞挂
    settings = { ...DEFAULT_SETTINGS };
  }
  return settings;
}

const HOME = { x: 0.85, y: 0.2 }; // 「回原位」的落点（右上角附近，与默认角落一致）

const DIAG = [
  { re: /左上|左上方|斜向左上/, dx: -1, dy: -1 },
  { re: /右上|右上方|斜向右上/, dx: 1, dy: -1 },
  { re: /左下|左下方|斜向左下/, dx: -1, dy: 1 },
  { re: /右下|右下方|斜向右下/, dx: 1, dy: 1 },
];
const UP = /往上|向上|上去|升起来|飘上去|上面去|上来/;
const DOWN = /往下|向下|下来|下去|落下来|下面去/;
const HOME_RE = /回原位|回角落|回到角落|回初始位置|回老地方/;
const CENTER_RE = /到中间|去中间|站中间/;

/** 当前（估计）位置：只有我们自己发过 /position 才知道，首次用默认右上角 */
let posRef = null;
function clamp01(v) {
  return Math.min(0.95, Math.max(0.05, v));
}

/**
 * 意图判定（纯函数，便于离线测试）：
 *   1) 方向 + 位移动词 → 移动类动画 + facing
 *   2) 动作目录：取命中的最长关键词
 *   3) 情绪兜底：用户没明说时，按回复口吻给一个反应
 */
export function decide(userText, replyText) {
  const u = userText || '';
  const r = replyText || '';

  // 0) 二维移动：斜向 > 纵向 > 回到固定点（都走 /position 滑行）
  for (const d of DIAG) {
    if (d.re.test(u)) {
      return {
        kind: 'pos',
        dx: d.dx * settings.stepX,
        dy: d.dy * settings.stepY,
        anim: '螃蟹走路',
        facing: d.dx < 0 ? 'left' : 'right',
        why: '斜着挪',
      };
    }
  }
  if (UP.test(u)) return { kind: 'pos', dx: 0, dy: -settings.stepY, anim: '原地漂浮踏步', why: '往上飘' };
  if (DOWN.test(u)) return { kind: 'pos', dx: 0, dy: settings.stepY, anim: '原地漂浮踏步', why: '往下落' };
  if (HOME_RE.test(u)) return { kind: 'pos', abs: HOME, anim: '原地漂浮踏步', why: '回原位' };
  if (CENTER_RE.test(u)) return { kind: 'pos', abs: { x: 0.5, y: 0.5 }, anim: '原地漂浮踏步', why: '到中间' };

  // 1) 左右移动（优先于目录，因为「往左跑」里也含「跑」）
  if (DIR.motion.test(u)) {
    if (DIR.left.test(u)) return { name: '原地左转奔跑', facing: 'left', why: '往左走' };
    if (DIR.right.test(u)) return { name: '原地左转奔跑', facing: 'right', why: '往右走' };
  }

  // 1.5) 直接的疲惫信号：不用等回复，直接给个「缩起来睡」的回应
  if (/好累|累死|累了|好困|困死/.test(u)) return { name: '原地小憩沉眠', why: '累了' };

  // 2) 动作目录：最长键优先
  for (const rule of RULES) {
    if (!u.includes(rule.k)) continue;
    const facing = DIR.left.test(u) ? 'left' : DIR.right.test(u) ? 'right' : undefined;
    const move = MOVE_ANIMS.has(rule.name);
    return {
      name: rule.name,
      why: `命中「${rule.k}」`,
      // 移动类只有在用户给了方向时才带 facing；没给就保持当前朝向
      ...(move && facing ? { facing } : {}),
    };
  }

  // 3) 情绪兜底：只看回复口吻，避免无关闲聊也乱动
  if (/害羞|脸红|不好意思/.test(r)) return { name: '点击回应-害羞惊讶', why: '回复害羞' };
  if (/哼|才不|讨厌/.test(r)) return { name: '点击回应-傲娇生气', why: '回复傲娇' };
  if (/哈哈|开心|好耶/.test(r)) return { name: '点击回应-开心跃动', why: '回复开心' };
  return null;
}

// ---------------- 端口探测 ----------------
async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/state`, {
      signal: AbortSignal.timeout(600),
    });
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j && typeof j === 'object' && 'counter' in j);
  } catch {
    return false;
  }
}

async function discoverPort() {
  if (PORT_ARG) {
    if (await probe(PORT_ARG)) return PORT_ARG;
    log(`指定的端口 ${PORT_ARG} 上没有 DSH`);
  }
  let out = '';
  try {
    // 沙箱里子进程的**管道** stdio 会被拒绝（EPERM），所以把 stdout 重定向到临时文件再读
    const tmp = `${import.meta.dirname}\\netstat.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      spawnSync('netstat', ['-ano'], { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
    } finally {
      closeSync(fd);
    }
    out = readFileSync(tmp, 'utf8');
    try {
      unlinkSync(tmp);
    } catch {}
  } catch (e) {
    log(`netstat 失败：${e.message}`);
    return 0;
  }
  const ports = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+\d+/);
    if (m) ports.add(Number(m[1]));
  }
  const list = [...ports];
  const hits = await Promise.all(list.map(async (p) => ((await probe(p)) ? p : 0)));
  return hits.find((p) => p > 0) ?? 0;
}

// ---------------- 记忆读取 ----------------
let lastTs = 0;
let lastAnimAt = 0;

function readMessages() {
  const j = JSON.parse(readFileSync(MEMORY, 'utf8'));
  return j?.['main']?.[PET]?.messages ?? [];
}

function lastUserTs() {
  try {
    const list = readMessages();
    for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'user') return list[i].ts || 0;
  } catch {}
  return 0;
}

/** 找「用户刚说 + 助手已回」的一对；没有新的返回 null */
function nextPair() {
  const list = readMessages();
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== 'user') continue;
    if (!m.ts || m.ts <= lastTs) return null;
    for (let k = i + 1; k < list.length; k++) {
      if (list[k].role === 'assistant') {
        return { user: m.content || '', reply: list[k].content || '', ts: m.ts };
      }
    }
    return null; // 回复还没落盘，下一拍再看
  }
  return null;
}

// ---------------- 点播 ----------------
async function play(base, action) {
  // 契约：pet / surface 走 query，动画本身走 **JSON body**（name 与 url 恰好一个，facing 可选）
  const q = new URLSearchParams({ pet: PET, surface: 'any' });
  const url = `http://127.0.0.1:${base}/dsh-pet-7340/anim?${q}`;
  const payload = { name: action.name, ...(action.facing ? { facing: action.facing } : {}) };
  if (DRY) {
    log(`[dry] ${action.name}${action.facing ? ` facing=${action.facing}` : ''} (${action.why})`);
    return 'ok';
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    const j = await res.json();
    if (j?.ok) {
      log(`▶ ${action.name}${action.facing ? ` facing=${action.facing}` : ''}  (${action.why})`);
      return 'ok';
    }
    log(`✗ 点播被拒：${j?.reason ?? 'unknown'} ${j?.message ?? ''}`.trim());
    return 'rejected';
  } catch (e) {
    log(`✗ 点播失败：${e.message}（重新探测端口）`);
    return 'neterr';
  }
}

// ---------------- 2D 移动（滑行）----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让宠物滑到目标点：先点播一个移动动画（可选），再下位置指令 */
async function playPos(base, action) {
  // 首次使用：从 /state 捞上一次的位置叶子作为相对位移的起点（没有就用默认右上角）
  if (!posRef) {
    try {
      const s = await (
        await fetch(`http://127.0.0.1:${base}/dsh-pet-7340/state`, { signal: AbortSignal.timeout(1500) })
      ).json();
      const p = s?.pets?.[PET]?.position?.data;
      posRef =
        p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : { ...HOME };
    } catch {
      posRef = { ...HOME };
    }
  }
  const target = action.abs ?? {
    x: clamp01(posRef.x + action.dx),
    y: clamp01(posRef.y + action.dy),
  };

  if (DRY) {
    log(`[dry] 滑到 (${target.x.toFixed(2)}, ${target.y.toFixed(2)})  (${action.why})`);
    posRef = target;
    return 'ok';
  }

  try {
    // 先点播动画，隔一拍再下位置指令：位置系统接管会停掉走路的位移循环，
    // 但**动画本身会继续播**，于是看起来是「一边走一边挪」而不是纯滑行。
    if (action.anim) {
      const q = new URLSearchParams({ pet: PET, surface: 'any' });
      await fetch(`http://127.0.0.1:${base}/dsh-pet-7340/anim?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: action.anim, ...(action.facing ? { facing: action.facing } : {}) }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
      // 前摇：动画开头有一段准备帧，等它过去再开始位移，否则看着像"人还没动、位置已经走了"
      if (settings.leadMs > 0) await sleep(settings.leadMs);
    }
    const q = new URLSearchParams({ pet: PET, surface: 'any' });
    const res = await fetch(`http://127.0.0.1:${base}/dsh-pet-7340/position?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: target.x, y: target.y, mode: 'line', duration: settings.glideMs }),
      signal: AbortSignal.timeout(3000),
    });
    const j = await res.json();
    if (j?.ok) {
      // 宿主会把越界值夹取后回传，以它为准，别让本地估计漂掉
      posRef = { x: typeof j.x === 'number' ? j.x : target.x, y: typeof j.y === 'number' ? j.y : target.y };
      log(`↗ (${posRef.x.toFixed(2)}, ${posRef.y.toFixed(2)})  (${action.why})`);
      return 'ok';
    }
    log(`✗ 移动被拒：${j?.reason ?? 'unknown'} ${j?.message ?? ''}`.trim());
    return 'rejected';
  } catch (e) {
    log(`✗ 移动失败：${e.message}（重新探测端口）`);
    return 'neterr';
  }
}

// ---------------- 余额 → 人设（让模型"知道"余额） ----------------
// 不改插件：把「当前余额」作为一行字符串拼进宠物的 whisperPrompt（人设）。
// 宿主每次对话都会重新读配置、把 whisperPrompt 放进 system prompt，于是模型自然知道这个数字。
// 余额本身读 /state 的 balance 段（与插件自己显示的完全同源），不额外打账号接口。
const BALANCE_MARK = '【当前余额】';
let personaBase = null;
let lastBalanceSync = 0;

/** 去掉我们以前注入的余额块，还原用户原本的人设 */
function stripBalance(prompt) {
  const i = prompt.indexOf(BALANCE_MARK);
  return (i >= 0 ? prompt.slice(0, i) : prompt).replace(/\s+$/, '');
}

/** 用户层没写过人设时，从 /config 拿内置默认那份（同样要剥掉注入块） */
async function effectivePersona(base) {
  try {
    const cfg = await (
      await fetch(`http://127.0.0.1:${base}/dsh-pet-7340/config`, { signal: AbortSignal.timeout(2000) })
    ).json();
    return stripBalance(String(cfg?.main?.whisperPrompt ?? ''));
  } catch {
    return null;
  }
}

/** 把一行余额写进 main-config.jsonc 的 pets[].whisperPrompt（临时文件 + 原子替换） */
function writePersona(line) {
  const file = join(dirname(MEMORY), 'main-config.jsonc');
  const conf = JSON.parse(readFileSync(file, 'utf8')); // 带注释的 JSONC 会抛 → 上层捕获并跳过
  const pets = Array.isArray(conf.pets) ? conf.pets : [];
  if (!pets.length) return;
  const pet = pets.find((p) => p && p.id === PET) ?? pets[0];
  if (!pet) return;
  const base = stripBalance(String(pet.whisperPrompt ?? personaBase ?? ''));
  // 人设为空（既没写过、/config 也没拿到）→ 宁可这次不注入，也不能把人格冲成只剩一行余额
  if (!base) return;
  const next = `${base}\n\n${line}`.trim();
  if (pet.whisperPrompt === next) return;
  pet.whisperPrompt = next;
  const out = `${JSON.stringify(conf, null, 2)}\n`;
  JSON.parse(out); // 自检：确保写出去的一定是合法 JSON
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, file); // 同目录 rename：原子替换，宿主读不到半截文件
  log('余额已写进人设（模型下一轮就能看到）');
}

async function syncBalance(base) {
  if (settings.balancePersona === false) return;
  const every = Number(settings.balanceSyncMs) > 5000 ? Number(settings.balanceSyncMs) : 60000;
  if (Date.now() - lastBalanceSync < every) return;
  lastBalanceSync = Date.now();
  try {
    const st = await (
      await fetch(`http://127.0.0.1:${base}/dsh-pet-7340/state`, { signal: AbortSignal.timeout(2500) })
    ).json();
    const b = st?.sections?.balance?.data;
    if (!b?.ok) return; // 余额不可用（未登录/查询失败）：保持原人设不动
    const w = (b.data?.wallets ?? [])[0];
    if (!w) return;
    if (personaBase === null) personaBase = await effectivePersona(base);
    const money = w.currency === 'CNY' ? `¥${w.total}` : `${w.currency} ${w.total}`;
    const when = new Date().toTimeString().slice(0, 5);
    writePersona(
      `${BALANCE_MARK}主人的 DeepSeek 余额：${money}（赠送 ${w.granted} / 充值 ${w.toppedUp}），更新于 ${when}。` +
        '主人问起余额时直接说出这个数字，不要说不知道、也不要含糊；不要主动提起余额；这只是背景信息，不是主人说的话。',
    );
  } catch {
    // 配置文件有注释 / 被占用 / 网络抖动：这次不写，下一拍再试
  }
}

// ---------------- 主循环 ----------------
let base = 0;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (!base) {
      base = await discoverPort();
      if (!base) return; // 下一拍再试
      log(`连上 DSH：127.0.0.1:${base}`);
      lastTs = lastUserTs();
      void syncBalance(base);
      return;
    }
    void syncBalance(base); // 后台同步余额到人设（有节流，不会每拍都写盘）
    const pair = nextPair();
    if (!pair) return;
    if (Date.now() - pair.ts > MAX_AGE_MS) {
      lastTs = pair.ts; // 太旧（启动前的历史）直接跳过
      return;
    }
    loadSettings(); // 每拍重读：改 settings.json 不用重启
    const action = decide(pair.user, pair.reply);
    if (!action) {
      lastTs = pair.ts;
      return;
    }
    if (Date.now() - lastAnimAt < COOLDOWN_MS) {
      lastTs = pair.ts;
      log(`冷却中，跳过：${action.why}`);
      return;
    }
    const result = action.kind === 'pos' ? await playPos(base, action) : await play(base, action);
    if (result === 'neterr') {
      base = 0; // DSH 重启换了端口：不推进 lastTs，重新连上后重试
      return;
    }
    lastTs = pair.ts;
    if (result === 'ok') lastAnimAt = Date.now();
  } catch (e) {
    // 记忆文件正在被重写（读到半截 JSON）等：静默跳过，下一拍再看
    if (!(e instanceof SyntaxError)) log(`tick 异常：${e.message}`);
  } finally {
    busy = false;
  }
}

// ---------------- 离线自检 ----------------
function selftest() {
  let bad = 0;
  const names = Object.keys(CATALOG);
  for (const name of names) {
    for (const key of keysOf(name, CATALOG[name])) {
      const got = decide(key, '');
      if (!got || got.name !== name) {
        bad++;
        console.log(`✗ 「${key}」→ ${got ? got.name : '无动作'}（应为 ${name}）`);
      }
    }
  }
  console.log(`\n目录共 ${names.length} 个动作，规则 ${RULES.length} 条，失败 ${bad} 条`);
  return bad === 0 ? 0 : 1;
}

if (SELFTEST) {
  process.exit(selftest());
}
if (TEST) {
  loadSettings();
  const r = decide(TEST, '');
  if (!r) console.log(`${TEST}  →  无动作（只说话）`);
  else if (r.kind === 'pos') {
    const t = r.abs ?? { x: clamp01(HOME.x + r.dx), y: clamp01(HOME.y + r.dy) };
    console.log(
      `${TEST}  →  滑到 (${t.x.toFixed(2)}, ${t.y.toFixed(2)})${r.anim ? ` + ${r.anim}` : ''}  (${r.why})`,
    );
  } else console.log(`${TEST}  →  ${r.name}${r.facing ? ` facing=${r.facing}` : ''}  (${r.why})`);
  process.exit(0);
}

// ---------------- 启动 ----------------
loadSettings();
log(`启动：pet=${PET} memory=${MEMORY} poll=${POLL_MS}ms cooldown=${COOLDOWN_MS}ms${DRY ? ' [dry]' : ''}`);
log(`动作目录 ${Object.keys(CATALOG).length} 个 / 规则 ${RULES.length} 条`);
log(`滑行：${settings.glideMs}ms + 前摇 ${settings.leadMs}ms / 步长 x=${settings.stepX} y=${settings.stepY}（改 settings.json 即时生效）`);
log(
  `余额人设：${settings.balancePersona ? `每 ${Math.round(settings.balanceSyncMs / 1000)}s 同步一次` : '已关闭'}` +
    `（${join(dirname(MEMORY), 'main-config.jsonc')}）`,
);
const PID_FILE = `${import.meta.dirname}\\director.pid`;
try {
  writeFileSync(PID_FILE, String(process.pid));
} catch {}
const bye = () => {
  try {
    unlinkSync(PID_FILE);
  } catch {}
};
process.on('exit', bye);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

tick();
setInterval(tick, POLL_MS);

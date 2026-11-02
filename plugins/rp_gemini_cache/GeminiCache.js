/**
 * OpenRouter · Gemini 角色扮演提示缓存优化
 *
 * 原理：
 *  - OpenRouter 对 Gemini 支持类似 Anthropic 的 `cache_control` 显式缓存断点（只有最后一个断点生效），
 *    缓存读取约为输入价格的 0.25x；Gemini 2.5+ 另有默认开启的隐式缓存（TTL 约 3~5 分钟），
 *    两者都要求请求「前缀」逐字节一致才能命中。
 *  - RP 场景下，rp_basic 构造的系统提示/角色卡/世界书常驻条目位于消息开头，是天然的稳定前缀；
 *    本插件在这些前缀的末尾打上 cache_control，并在前缀变化时给出原因提示（例如 {{time}} 宏）。
 *  - 可选：开启 OpenRouter 响应缓存（X-OpenRouter-Cache: true），完全相同的请求直接返回缓存结果。
 *
 * 仅通过 COMPLETION_PAYLOAD_HOOKS / USAGE_HOOKS 两个钩子工作，不修改 rp_basic 数据结构。
 */
import {COMPLETION_PAYLOAD_HOOKS, USAGE_HOOKS} from "/src/api-request.js";
import {GLOBAL_SETTINGS} from "/src/settings.js";
import {config} from "/src/states.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {showToast} from "/src/components/Toast.js";
import SimpleModal from "/src/components/SimpleModal.jsx";

const TAB = "provider";

GLOBAL_SETTINGS.push({
	_tab: TAB,
	id: "gcacheMode",
	name: "[Gemini缓存] 显式缓存断点",
	type: "radio",
	required: true,
	default: "prefix",
	choices: {
		"关闭": "off",
		"系统前缀": "prefix",
		"前缀+历史": "history"
	},
	title: {
		"关闭": "不添加 cache_control，仅依赖 Gemini 隐式缓存",
		"系统前缀": "在开头连续的 system 消息（系统提示/角色卡/世界书常驻）末尾添加 cache_control",
		"前缀+历史": "断点放在最新用户消息之前，缓存系统前缀+历史对话（长对话更省，OpenRouter 对 Gemini 只使用最后一个断点）"
	}
}, {
	_tab: TAB,
	id: "gcacheMergeSystem",
	name: "[Gemini缓存] 合并开头 system 消息",
	type: "radio",
	required: true,
	default: true,
	choices: {"开启": true, "关闭": false},
	title: {"开启": "将开头连续的多条 system 消息合并为一条，保证断点覆盖完整固定前缀"}
}, {
	_tab: TAB,
	id: "gcacheTTL",
	name: "[Gemini缓存] 缓存 TTL",
	type: "radio",
	required: true,
	default: "",
	choices: {"默认(5分钟)": "", "1小时": "1h"},
	title: {"1小时": "写入 cache_control.ttl = \"1h\"（若供应商不支持会被忽略或按默认处理）"}
}, {
	_tab: TAB,
	id: "gcacheResponseCache",
	name: "[Gemini缓存] OpenRouter 响应缓存",
	type: "radio",
	required: true,
	default: false,
	choices: {"开启": true, "关闭": false},
	title: {"开启": "发送 X-OpenRouter-Cache: true，完全相同的请求直接返回缓存的回复（重 roll 时会得到同样结果！）"}
}, {
	_tab: TAB,
	id: "gcacheToast",
	name: "[Gemini缓存] 命中提示",
	type: "radio",
	required: true,
	default: true,
	choices: {"开启": true, "关闭": false},
	title: {"开启": "每次回复结束后以 Toast 显示缓存命中 token 数"}
});

const opt = (k, d) => config[k] ?? d;

/** 是否为 OpenRouter 上的 Gemini 模型 */
export function isOpenRouterGemini(cfg) {
	const model = String(cfg.model || "").toLowerCase();
	const endpoint = String(cfg.endpoint || "").toLowerCase();
	const isOR = endpoint.includes("openrouter.ai") || String(cfg.accessToken || "").startsWith("sk-or-");
	if (!isOR) return false;
	return model.startsWith("google/gemini") || model.startsWith("~google/gemini") || /(^|\/)gemini-/.test(model);
}

const partsText = c => typeof c === "string" ? c : Array.isArray(c) ? c.map(p => p?.type === "text" ? p.text : "[" + (p?.type || "?") + "]").join("") : JSON.stringify(c ?? "");

function addBreakpoint(msg, ttl) {
	const cc = {type: "ephemeral"};
	if (ttl) cc.ttl = ttl;
	let c = msg.content;
	if (typeof c === "string") {
		if (!c) return false;
		msg.content = [{type: "text", text: c, cache_control: cc}];
		return true;
	}
	if (Array.isArray(c)) {
		for (let i = c.length - 1; i >= 0; i--) {
			if (c[i]?.type === "text" && c[i].text) {
				c[i] = {...c[i], cache_control: cc};
				return true;
			}
		}
	}
	return false;
}

// 统计（按会话）
const stats = new Map;
const last = {conv: null, model: null, applied: null};
const getStat = id => {
	let s = stats.get(id);
	if (!s) stats.set(id, s = {requests: 0, prefixChanges: 0, prefix: null, prefixLen: 0, hits: 0, cachedTokens: 0, promptTokens: 0, writeTokens: 0, lastDiff: null});
	return s;
};

function firstDiff(a, b) {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return {pos: i, before: a.slice(Math.max(0, i - 30), i + 50), after: b.slice(Math.max(0, i - 30), i + 50)};
}

COMPLETION_PAYLOAD_HOOKS.push((body, headers, {config: cfg, conversation}) => {
	last.applied = null;
	if (!isOpenRouterGemini(cfg)) return;
	last.conv = conversation?.id; last.model = cfg.model;

	if (opt("gcacheResponseCache", false)) headers["X-OpenRouter-Cache"] = "true";

	const msgs = body.messages;
	if (!Array.isArray(msgs) || !msgs.length) return;
	// 服务端 refs 模式（cached/cache_new 伪角色）不处理
	if (msgs.some(m => m.role === "cached" || m.role === "cache_new")) return;

	// 1. 合并开头连续 system 消息
	let k = 0;
	while (k < msgs.length && msgs[k].role === "system") k++;
	if (k > 1 && opt("gcacheMergeSystem", true) && msgs.slice(0, k).every(m => typeof m.content === "string")) {
		const merged = {role: "system", content: msgs.slice(0, k).map(m => m.content).filter(Boolean).join("\n\n")};
		msgs.splice(0, k, merged);
		k = 1;
	}

	// 2. 前缀稳定性追踪
	const prefixText = msgs.slice(0, k).map(m => partsText(m.content)).join("\n\0\n");
	const s = getStat(conversation?.id);
	s.requests++;
	if (s.prefix != null && s.prefix !== prefixText) {
		s.prefixChanges++;
		s.lastDiff = firstDiff(s.prefix, prefixText);
	}
	s.prefix = prefixText; s.prefixLen = prefixText.length;

	// 3. 断点
	const mode = opt("gcacheMode", "prefix");
	if (mode === "off") return;
	const ttl = opt("gcacheTTL", "") || undefined;
	let target = -1;
	if (mode === "history") {
		// 最后一条 user 消息之前的那条（user/assistant/tool 均可，需含文本）
		const lastUser = msgs.findLastIndex(m => m.role === "user");
		for (let i = (lastUser > 0 ? lastUser : msgs.length) - 1; i >= 0; i--) {
			const c = msgs[i].content;
			if ((typeof c === "string" && c) || (Array.isArray(c) && c.some(p => p?.type === "text" && p.text))) { target = i; break; }
		}
	}
	if (target < 0 && k > 0) target = k - 1;
	if (target >= 0 && addBreakpoint(msgs[target], ttl)) last.applied = {index: target, mode};
});

USAGE_HOOKS.push((usage, log) => {
	if (!last.model || !last.conv) return;
	if (!isOpenRouterGemini({...config, model: last.model, endpoint: config.endpoint})) return;
	const s = getStat(last.conv);
	const d = usage.prompt_tokens_details || {};
	const cached = d.cached_tokens || 0, write = d.cache_write_tokens || 0, prompt = usage.prompt_tokens || 0;
	s.promptTokens += prompt; s.cachedTokens += cached; s.writeTokens += write;
	if (cached) s.hits++;
	if (opt("gcacheToast", true)) {
		const pct = prompt ? Math.round(cached / prompt * 100) : 0;
		showToast(cached
			? `Gemini 缓存命中 ${cached}/${prompt} tokens (${pct}%)` + (write ? `，写入 ${write}` : "")
			: `Gemini 缓存未命中（输入 ${prompt} tokens${write ? `，写入 ${write}` : ""}）`, cached ? "ok" : undefined);
	}
	last.model = null;
});

COMMAND_REGISTRY["gcache"] = [() => {
	const lines = [];
	const s = stats.get(last.conv) || [...stats.values()].at(-1);
	lines.push("当前模型：" + (config.model || "?") + (isOpenRouterGemini(config) ? "（已识别为 OpenRouter Gemini ✅）" : "（非 OpenRouter Gemini，插件不生效）"));
	lines.push(`断点模式：${opt("gcacheMode", "prefix")}　合并system：${opt("gcacheMergeSystem", true) ? "是" : "否"}　TTL：${opt("gcacheTTL", "") || "默认"}　响应缓存：${opt("gcacheResponseCache", false) ? "开" : "关"}`);
	if (!s) lines.push("\n本次运行尚无请求统计。");
	else {
		lines.push(`\n请求数：${s.requests}　命中次数：${s.hits}`);
		lines.push(`累计输入：${s.promptTokens}　缓存读取：${s.cachedTokens}（${s.promptTokens ? Math.round(s.cachedTokens / s.promptTokens * 100) : 0}%）　缓存写入：${s.writeTokens}`);
		lines.push(`固定前缀长度：约 ${s.prefixLen} 字符（≈${Math.round(s.prefixLen / 3)} tokens；Gemini 显式缓存通常需 ≥1024~4096 tokens）`);
		lines.push(`前缀变化次数：${s.prefixChanges}`);
		if (s.lastDiff) lines.push(`最近一次前缀变化位置 #${s.lastDiff.pos}：\n  之前：…${s.lastDiff.before}…\n  之后：…${s.lastDiff.after}…\n提示：系统提示/角色卡中的 {{time}}、{{date}}、随机宏、按关键词触发的世界书条目会破坏前缀，建议移到对话末尾（深度注入）。`);
	}
	SimpleModal({title: "OpenRouter Gemini 缓存状态", message: lines.join("\n")});
}, "查看 OpenRouter Gemini 提示缓存命中与前缀稳定性"];

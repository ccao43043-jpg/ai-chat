/**
 * RP 模板首条消息 → 确认后生成角色卡
 *
 * 触发：编辑器当前选中了 st|preset，且对话尚无 st|char，且本轮是首条用户消息。
 * 同意后：复用 plugins/rpg/core.js 的 runSchemaRole + character.schema.json5 生成，
 * 映射为 st|char 入库并绑定到当前对话，再继续正常回复。
 */
import {
	EVENT_BUS,
	MessageRoles,
	messages,
	selectedConversation,
	updateMessageUI,
	config,
} from "/src/states.js";
import {$update, AS_IS, debugSymbol, unconscious} from "unconscious";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {showToast} from "/src/components/Toast.js";
import {kvListGet, kvListSet, updateConversation} from "/src/database.js";
import {prettyError, getTextContent} from "/src/utils/utils.js";
import {runSchemaRole, USER_PROMPT} from "/plugins/rpg/core.js";
import {schemaToPrompt} from "/common/ReactiveJSON.js";
import {createJsonParser, parseJson5} from "unconscious/common/Json.js";
import characterSchemaText from "/plugins/rpg/skills/character.schema.json5?raw";

const ASKED = debugSymbol("RPCharGenAsked");
const BUSY = debugSymbol("RPCharGenBusy");
const ROLE_ID = "rp/charGen";

/** @type {OpenAI.ObjectSchema|null} */
let cachedSchema = null;

/**
 * 基于 character.schema.json5，补齐映射所需字段并修正严格 JSON Schema 兼容性。
 * @returns {OpenAI.ObjectSchema}
 */
function getGenerationSchema() {
	if (cachedSchema) return cachedSchema;

	const base = parseJson5(characterSchemaText);
	const schema = structuredClone(base);

	// skills：上游 required 含 description，但 properties 写的是 cost_and_limit —— 两边都保留
	const skillProps = schema.properties.skills.items.properties;
	if (!skillProps.description) {
		skillProps.description = {
			type: "string",
			description: "技能效果简述，约50字。",
		};
	}
	schema.properties.skills.items.required = ["name", "description", "cost_and_limit"];

	// attributes：允许自由键值，便于无世界观面板时也能输出
	schema.properties.attributes = {
		type: "object",
		description: "角色的初始数值面板（键为属性名，值为合理初始值或简述）。无明确数值体系时可给空对象。",
		additionalProperties: {
			oneOf: [
				{type: "string"},
				{type: "number"},
			],
		},
	};

	// 便于映射到 st|char
	schema.properties.scenario = {
		type: "string",
		description: "当前开场情景设定，约100-200字。结合用户首条消息，写明时间地点与双方关系。",
	};
	schema.properties.greeting = {
		type: "string",
		description: "角色的开场白（第一人称或旁白皆可），沉浸、有画面感，约150-300字。",
	};
	schema.properties.systemPrompt = {
		type: "string",
		description: "可选。覆盖默认系统提示的短指令；没有特殊需求时输出空字符串。",
	};

	const req = new Set(schema.required || []);
	req.add("scenario");
	req.add("greeting");
	schema.required = [...req];

	cachedSchema = schema;
	return schema;
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function asText(content) {
	if (typeof content === "string") return content;
	return getTextContent({content}) || "";
}

/**
 * 将 schema 生成结果映射为 st|char。
 * @param {Record<string, any>} gen
 * @param {string} userSeed
 * @returns {AiChat.DnD.MyCharacter}
 */
export function mapGeneratedToCharacter(gen, userSeed = "") {
	const name = String(gen?.name || "未命名角色").trim() || "未命名角色";
	const tags = Array.isArray(gen?.tags)
		? gen.tags.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
		: [];

	const appearance = gen?.appearance ? `【外貌】\n${gen.appearance}` : "";
	const background = gen?.background ? `【背景】\n${gen.background}` : "";
	const faction = gen?.faction ? `【阵营】${gen.faction}` : "";
	const basics = [
		gen?.alias && `别名：${gen.alias}`,
		gen?.sex && `性别：${gen.sex}`,
		gen?.race && `种族：${gen.race}`,
		gen?.age && `年龄：${gen.age}`,
	].filter(Boolean).join(" · ");

	const skillLines = Array.isArray(gen?.skills)
		? gen.skills.map((s) => {
			if (!s) return "";
			const desc = s.description || s.cost_and_limit || "";
			const limit = s.cost_and_limit && s.description ? `（限制：${s.cost_and_limit}）` : "";
			return `- ${s.name}${desc ? "：" + desc : ""}${limit}`;
		}).filter(Boolean)
		: [];

	const attrEntries = gen?.attributes && typeof gen.attributes === "object"
		? Object.entries(gen.attributes).map(([k, v]) => `- ${k}: ${v}`)
		: [];

	const description = [
		basics,
		appearance,
		background,
		faction,
		skillLines.length ? `【技能】\n${skillLines.join("\n")}` : "",
		attrEntries.length ? `【属性】\n${attrEntries.join("\n")}` : "",
		gen?.design ? `【设计备注】\n${gen.design}` : "",
	].filter(Boolean).join("\n\n").trim() || userSeed.slice(0, 500);

	const tagDescs = Array.isArray(gen?.tags)
		? gen.tags.map((t) => {
			if (!t || typeof t === "string") return "";
			return t.description ? `${t.name}：${t.description}` : t.name;
		}).filter(Boolean)
		: [];

	const personality = [
		tagDescs.length ? tagDescs.join("\n") : tags.join("、"),
		gen?.flaw ? `【弱点/执念】\n${gen.flaw}` : "",
	].filter(Boolean).join("\n\n").trim();

	const greeting = String(gen?.greeting || "").trim()
		|| `*${name}看向你，微微颔首。*\n「……你好。」`;

	/** @type {AiChat.DnD.MyCharacter} */
	return {
		type: "st|char",
		name,
		time: Date.now(),
		creator: "auto-gen",
		creatorNotes: gen?.design ? String(gen.design).slice(0, 500) : "由首条消息自动生成",
		tags,
		systemPrompt: String(gen?.systemPrompt || ""),
		description,
		personality,
		scenario: String(gen?.scenario || userSeed.slice(0, 400) || ""),
		dialogueExamples: [],
		greetings: [greeting],
		lorebook: [],
		autoMessages: [],
	};
}

/**
 * @param {string} userText
 * @param {import("unconscious").Reactive<AiChat.Message[]>} msgState
 * @returns {Promise<Record<string, any>>}
 */
async function runCharacterGeneration(userText, msgState) {
	const schema = getGenerationSchema();
	const conf = unconscious(config);
	const prompt = `你是资深角色卡设计师。请根据用户给出的灵感/首条消息，生成一张完整、可直接用于角色扮演的角色卡。
要求：
1. 严格输出符合 Schema 的 JSON（不要 Markdown 围栏外的闲聊）。
2. 若用户已给出姓名、性别、设定等，优先沿用，不要无故改名。
3. 文风沉浸，信息密度高；greeting 与 scenario 必须可直接开场。
4. 使用简体中文。

${schemaToPrompt(schema, conf.jsonSupport)}

## 用户首条消息（灵感）

${userText}`;

	const beforeLen = unconscious(msgState).length;
	let captured = null;

	const prevRole = MessageRoles[ROLE_ID];
	MessageRoles[ROLE_ID] = {
		name: "角色卡生成",
		async onCompleted(_conversation, msgs, cfg) {
			const assistantResponse = msgs.at(-1);
			const content = assistantResponse.content;
			const parser = createJsonParser(AS_IS, {json5: true});
			const text = cfg?.jsonSupport
				? content
				: String(content || "").replace(/^\s*```(?:json5?|json)?\s*/i, "").replace(/\s*```\s*$/, "");
			parser.write(typeof text === "string" ? text : JSON.stringify(text));
			captured = parser.end(true);
			assistantResponse.content = captured;
			assistantResponse.role = ROLE_ID;

			const userMessage = msgs.at(-2);
			if (userMessage?.role === "userPrompt") {
				msgs[msgs.length - 2] = {...userMessage, role: "user"};
			}
		},
	};

	msgState.push({
		role: "userPrompt",
		time: Date.now(),
		content: "正在根据当前信息生成角色卡…",
		[USER_PROMPT]: prompt,
	});
	$update(updateMessageUI);

	const conv = unconscious(selectedConversation);
	try {
		await runSchemaRole(ROLE_ID, schema, msgState, {
			think: false,
			max_completion_tokens: 8192,
		});
	} finally {
		if (prevRole) MessageRoles[ROLE_ID] = prevRole;
		else delete MessageRoles[ROLE_ID];

		// 撤掉生成过程消息，避免污染对话
		const list = unconscious(msgState);
		while (list.length > beforeLen) {
			msgState.pop();
		}
		$update(updateMessageUI);
		try {
			await updateConversation(conv, unconscious(msgState));
		} catch (e) {
			console.warn("清理角色卡生成临时消息失败", e);
		}
	}

	if (!captured || typeof captured !== "object") {
		throw new Error("角色卡生成结果为空或无法解析为 JSON");
	}
	return captured;
}

/**
 * @param {AiChat.DnD.MyCharacter} char
 * @param {string[]} existingNames
 */
function uniquifyName(char, existingNames) {
	if (!existingNames.includes(char.name)) return;
	const base = char.name;
	char.name = `${base}-${Date.now().toString(36).slice(-4)}`;
	let i = 2;
	while (existingNames.includes(char.name)) {
		char.name = `${base}-${i++}`;
	}
}

/**
 * @param {AiChat.DnD.MyCharacter} char
 * @param {string|undefined} presetName
 * @param {{
 *   loadRPConversation: Function,
 *   currentCharacter: import("unconscious").Reactive<any>,
 *   characterList: import("unconscious").Reactive<any[]>,
 * }} api
 */
async function bindCharacterToConversation(char, presetName, api) {
	const existing = (unconscious(api.characterList) || []).map((x) => x.name);
	// 已存在同名则探测内容；空则允许覆盖自动生成
	if (existing.includes(char.name)) {
		try {
			const old = await kvListGet("st|char", char.name);
			if (old && old.creator !== "auto-gen") {
				uniquifyName(char, existing);
			}
		} catch {
			uniquifyName(char, existing);
		}
	}

	await kvListSet(char, "st|char");

	const conv = unconscious(selectedConversation);
	const list = unconscious(messages);

	if (list[0]?.role === "st|char") {
		list[0].content = {
			...list[0].content,
			name: char.name,
			presetName: presetName || list[0].content?.presetName,
			lorebookNames: list[0].content?.lorebookNames || [""],
			greeting: 0,
		};
	} else {
		messages.unshift({
			role: "st|char",
			content: {
				name: char.name,
				lorebookNames: [""],
				greeting: 0,
				presetName: presetName || undefined,
			},
			time: Date.now(),
		});
	}

	// isLoadFromDB=false：避免把 greeting 插进已有用户消息之前
	await api.loadRPConversation(conv, unconscious(messages), false);

	if (api.currentCharacter) {
		api.currentCharacter.value = char;
		delete api.currentCharacter._dirty;
		$update(api.currentCharacter);
	}
	if (api.characterList) {
		const names = unconscious(api.characterList) || [];
		if (!names.some((x) => x.name === char.name)) {
			api.characterList.value = [...names, {name: char.name, time: char.time}];
		}
	}

	if (!conv.title || conv.title.startsWith("临时") || conv.title === "新对话") {
		conv.title = "[Char] " + char.name;
	}

	await updateConversation(conv, unconscious(messages));
	$update(updateMessageUI);
	showToast(`已生成并绑定角色卡：${char.name}`, "ok");
}

/**
 * @param {{
 *   currentPreset: import("unconscious").Reactive<any>,
 *   loadRPConversation: Function,
 *   currentCharacter: import("unconscious").Reactive<any>,
 *   characterList: import("unconscious").Reactive<any[]>,
 *   submitUserChatMessage: Function,
 * }} deps
 */
export function registerAutoGenerateCharacter(deps) {
	const {
		currentPreset,
		loadRPConversation,
		currentCharacter,
		characterList,
		submitUserChatMessage,
	} = deps;

	/**
	 * @param {AiChat.Conversation} conv
	 * @returns {false|void}
	 */
	const onLoopEntry = (conv) => {
		if (!conv || conv[BUSY] || conv[ASKED]) return;
		if (conv.meta?.owner != null) return; // 子代理

		const list = unconscious(messages) || [];
		const preset = unconscious(currentPreset);
		const presetName = preset?.name;
		if (!presetName) return;

		// 已绑定角色卡则不再询问
		if (list[0]?.role === "st|char") return;

		const userMsgs = list.filter((m) => m.role === "user");
		if (userMsgs.length !== 1) return;

		const userText = asText(userMsgs[0].content).trim();
		if (!userText) return;

		conv[ASKED] = true;

		const resume = () => {
			queueMicrotask(() => {
				try {
					submitUserChatMessage(true, conv);
				} catch (e) {
					console.error(e);
					showToast("继续回复失败\n" + prettyError(e), "error");
				}
			});
		};

		SimpleModal({
			title: "生成角色卡",
			message: "是否按照当前信息去生成角色卡？",
			confirmMessage: "生成",
			cancelMessage: "跳过",
			onConfirm: () => {
				// 立即关闭弹窗，后台生成
				(async () => {
					conv[BUSY] = true;
					showToast("正在生成角色卡，请稍候…", "ok");
					try {
						const gen = await runCharacterGeneration(userText, messages);
						const char = mapGeneratedToCharacter(gen, userText);
						await bindCharacterToConversation(char, presetName, {
							loadRPConversation,
							currentCharacter,
							characterList,
						});
					} catch (e) {
						console.error(e);
						showToast("角色卡生成失败，将按原流程继续回复\n" + prettyError(e), "error", 8000);
					} finally {
						delete conv[BUSY];
						resume();
					}
				})();
			},
			onCancel: () => {
				resume();
			},
		});

		return false;
	};

	EVENT_BUS.on("loopEntry", onLoopEntry);
}

import { EXAM_FONT_GLYPH_HASH_MAP } from './yuketang.font.map';

type OpenTypeCommand = {
	type: string;
	x?: number;
	y?: number;
	x1?: number;
	y1?: number;
	x2?: number;
	y2?: number;
};

type OpenTypeGlyph = {
	getPath(x: number, y: number, fontSize: number): { commands: OpenTypeCommand[] };
};

type OpenTypeFont = {
	unitsPerEm: number;
	tables?: { cmap?: { glyphIndexMap?: Record<string, number> } };
	encoding?: { cmap?: { glyphIndexMap?: Record<string, number> } };
	glyphs: { get(index: number): OpenTypeGlyph | undefined };
};

type OpenTypeApi = {
	parse(buffer: ArrayBuffer): OpenTypeFont;
};

export type YuketangFontDecodeResult = {
	total: number;
	decoded: number;
	skipped: number;
	unmatchedFonts: string[];
};

const DECODING_ATTRIBUTE = 'data-ocs-yuketang-font-decoding';

const fontDecodeState = {
	loader: null as Promise<OpenTypeApi> | null,
	fontMaps: new Map<string, Map<string, string>>(),
	fontLoads: new Map<string, Promise<Map<string, string>>>(),
	decodeLoads: new WeakMap<Document, Promise<YuketangFontDecodeResult>>(),
	observers: new WeakMap<Document, MutationObserver>(),
	timers: new WeakMap<Document, number>(),
	frames: new WeakSet<HTMLIFrameElement>()
};

function emptyDecodeResult(): YuketangFontDecodeResult {
	return { total: 0, decoded: 0, skipped: 0, unmatchedFonts: [] };
}

function getHostWindow() {
	try {
		const hostWindow = (globalThis as any).unsafeWindow;
		if (hostWindow) {
			return hostWindow as Window & { opentype?: OpenTypeApi };
		}
	} catch {}
	return window as Window & { opentype?: OpenTypeApi };
}

function getElementWindow(element: Element) {
	return element.ownerDocument.defaultView || getHostWindow();
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(label)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

function loadOpenType() {
	const hostWindow = getHostWindow();
	if (hostWindow.opentype) {
		return Promise.resolve(hostWindow.opentype);
	}
	if (fontDecodeState.loader) {
		return fontDecodeState.loader;
	}

	const loadPromise = new Promise<OpenTypeApi>((resolve, reject) => {
		const script = hostWindow.document.createElement('script');
		script.src = 'https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js';
		script.async = true;
		script.onload = () => {
			if (hostWindow.opentype) {
				resolve(hostWindow.opentype);
			} else {
				reject(new Error('opentype.js loaded without exposing opentype'));
			}
		};
		script.onerror = () => reject(new Error('failed to load opentype.js'));
		hostWindow.document.head.appendChild(script);
	});

	fontDecodeState.loader = withTimeout(loadPromise, 15000, 'load opentype.js timeout').catch((error) => {
		fontDecodeState.loader = null;
		throw error;
	});
	return fontDecodeState.loader;
}

function toArrayBuffer(value: any): ArrayBuffer | null {
	if (value instanceof ArrayBuffer) {
		return value;
	}
	if (ArrayBuffer.isView(value)) {
		return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
	}
	return null;
}

async function requestArrayBuffer(url: string) {
	try {
		const response = await fetch(url);
		if (response.ok) {
			return await response.arrayBuffer();
		}
	} catch {}

	return new Promise<ArrayBuffer>((resolve, reject) => {
		const gmRequest = (globalThis as any).GM_xmlhttpRequest || (getHostWindow() as any).GM_xmlhttpRequest;
		if (typeof gmRequest !== 'function') {
			reject(new Error('download font failed and GM_xmlhttpRequest is unavailable'));
			return;
		}
		gmRequest({
			method: 'GET',
			url,
			responseType: 'arraybuffer',
			timeout: 15000,
			onload: (response: any) => {
				const status = Number(response?.status || 0);
				if (status && (status < 200 || status >= 300)) {
					reject(new Error(`download font failed: ${status}`));
					return;
				}
				const buffer = toArrayBuffer(response?.response);
				if (buffer) {
					resolve(buffer);
				} else {
					reject(new Error('font response is not an ArrayBuffer'));
				}
			},
			onerror: (error: any) => reject(error instanceof Error ? error : new Error(String(error))),
			ontimeout: () => reject(new Error('download font timeout'))
		});
	});
}

function normalizeFontFamilyName(value: string) {
	return String(value || '')
		.split(',')[0]
		.replace(/["']/g, '')
		.trim()
		.toLowerCase();
}

function getEncryptedFontInfo(element: HTMLElement) {
	const doc = element.ownerDocument || document;
	const view = getElementWindow(element);
	const family = normalizeFontFamilyName(view.getComputedStyle(element).fontFamily) || 'exam-data-decrypt-font';
	let src = '';

	for (const styleSheet of Array.from(doc.styleSheets || [])) {
		let rules: CSSRuleList | undefined;
		try {
			rules = styleSheet.cssRules;
		} catch {
			continue;
		}
		if (!rules) {
			continue;
		}
		for (const rule of Array.from(rules)) {
			if (rule.type !== CSSRule.FONT_FACE_RULE) {
				continue;
			}
			const fontFaceRule = rule as CSSFontFaceRule;
			const ruleFamily = normalizeFontFamilyName(fontFaceRule.style.getPropertyValue('font-family'));
			if (ruleFamily !== family) {
				continue;
			}
			const srcText = String(fontFaceRule.style.getPropertyValue('src') || '').trim();
			const urlMatch = srcText.match(/url\((['"]?)(.*?)\1\)/i);
			src = urlMatch ? urlMatch[2] : srcText;
			if (src) {
				try {
					src = new URL(src, doc.baseURI || location.href).toString();
				} catch {}
				break;
			}
		}
		if (src) {
			break;
		}
	}

	return { family, src, signature: `${family}|${src}` };
}

function getGlyphPathSignature(font: OpenTypeFont, glyph: OpenTypeGlyph) {
	const commands = glyph.getPath(0, 0, font.unitsPerEm).commands;
	const parts: string[] = [];
	for (const command of commands) {
		parts.push(command.type);
		if (command.x !== undefined) {
			parts.push(Number(command.x).toFixed(3));
			parts.push(Number(command.y).toFixed(3));
		}
		if (command.x1 !== undefined) {
			parts.push(Number(command.x1).toFixed(3));
			parts.push(Number(command.y1).toFixed(3));
		}
		if (command.x2 !== undefined) {
			parts.push(Number(command.x2).toFixed(3));
			parts.push(Number(command.y2).toFixed(3));
		}
	}
	return parts.join('|');
}

function fnv1a64(text: string) {
	const Big = BigInt;
	let hash = Big('0xcbf29ce484222325');
	const mask = Big('0xffffffffffffffff');
	const prime = Big('0x100000001b3');
	const bytes = new TextEncoder().encode(String(text || ''));
	for (const byte of bytes) {
		hash ^= Big(byte);
		hash = (hash * prime) & mask;
	}
	return hash.toString(16).padStart(16, '0');
}

async function ensureFontCharMap(fontInfo: { signature: string; src: string }) {
	const cached = fontDecodeState.fontMaps.get(fontInfo.signature);
	if (cached) {
		return cached;
	}
	const loading = fontDecodeState.fontLoads.get(fontInfo.signature);
	if (loading) {
		return loading;
	}

	const loadPromise = (async () => {
		const charMap = new Map<string, string>();
		try {
			if (!fontInfo.src) {
				throw new Error('missing encrypted font URL');
			}
			const opentype = await loadOpenType();
			const buffer = await withTimeout(requestArrayBuffer(fontInfo.src), 15000, 'download font timeout');
			const font = opentype.parse(buffer);
			const cmap = font.tables?.cmap?.glyphIndexMap || font.encoding?.cmap?.glyphIndexMap || {};
			for (const codePoint of Object.keys(cmap)) {
				const fakeChar = String.fromCodePoint(Number(codePoint));
				const glyph = font.glyphs.get(cmap[codePoint]);
				if (!glyph) {
					continue;
				}
				const glyphHash = fnv1a64(getGlyphPathSignature(font, glyph));
				const realChar = EXAM_FONT_GLYPH_HASH_MAP[glyphHash];
				if (realChar) {
					charMap.set(fakeChar, realChar);
				}
			}
		} catch (error) {
			console.error('[ocs:yuketang] font decode failed', error);
		}
		fontDecodeState.fontMaps.set(fontInfo.signature, charMap);
		fontDecodeState.fontLoads.delete(fontInfo.signature);
		return charMap;
	})();

	fontDecodeState.fontLoads.set(fontInfo.signature, loadPromise);
	return loadPromise;
}

function isEncryptedGlyphElement(element: Element) {
	if (element.nodeType !== Node.ELEMENT_NODE) {
		return false;
	}
	const htmlElement = element as HTMLElement;
	if (htmlElement.hasAttribute(DECODING_ATTRIBUTE)) {
		return false;
	}
	if (htmlElement.classList.contains('xuetangx-com-encrypted-font')) {
		return true;
	}
	const family = getElementWindow(element).getComputedStyle(htmlElement).fontFamily || '';
	if (!/exam-data-decrypt-font/i.test(family)) {
		return false;
	}
	// 新版考试页会给普通明文也设置这个字体族，但未必真的加载了解密字体。
	// 只有 FontFaceSet 中存在对应字体时才按动态字体处理，避免把整页明文误报为“哈希未命中”。
	const fontFaces = htmlElement.ownerDocument?.fonts;
	let hasMatchingFontFace = false;
	(fontFaces as any)?.forEach?.((fontFace: FontFace) => {
		if (/exam-data-decrypt-font/i.test(normalizeFontFamilyName(fontFace.family))) {
			hasMatchingFontFace = true;
		}
	});
	return hasMatchingFontFace;
}

function getEncryptedLeafElements(root: HTMLElement) {
	const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter((element) =>
		isEncryptedGlyphElement(element)
	);
	return elements.filter(
		(element) => !Array.from(element.querySelectorAll('*')).some((child) => isEncryptedGlyphElement(child))
	);
}

async function decodeEncryptedElement(element: HTMLElement) {
	const encryptedText = String(element.innerText || element.textContent || '');
	const fontInfo = getEncryptedFontInfo(element);
	const charMap = await ensureFontCharMap(fontInfo);
	return {
		text: Array.from(encryptedText)
			.map((character) => charMap.get(character) || character)
			.join(''),
		fontInfo,
		hasMap: charMap.size > 0
	};
}

async function decodeElementInPlace(root: HTMLElement): Promise<YuketangFontDecodeResult> {
	const encryptedLeaves = getEncryptedLeafElements(root);
	const unmatchedFonts = new Set<string>();
	let decoded = 0;
	let skipped = 0;

	for (const element of encryptedLeaves) {
		if (element.hasAttribute(DECODING_ATTRIBUTE)) {
			continue;
		}
		element.setAttribute(DECODING_ATTRIBUTE, 'true');
		try {
			const result = await decodeEncryptedElement(element);
			if (!result.hasMap) {
				skipped++;
				unmatchedFonts.add(result.fontInfo.src || result.fontInfo.signature);
				continue;
			}
			element.textContent = result.text;
			element.classList.remove('xuetangx-com-encrypted-font');
			element.style.fontFamily = 'inherit';
			decoded++;
		} finally {
			element.removeAttribute(DECODING_ATTRIBUTE);
		}
	}

	return {
		total: encryptedLeaves.length,
		decoded,
		skipped,
		unmatchedFonts: Array.from(unmatchedFonts)
	};
}

function getSameOriginDocuments(rootDocument: Document) {
	const documents: Document[] = [];
	const visited = new Set<Document>();
	const visit = (doc: Document) => {
		if (visited.has(doc)) {
			return;
		}
		visited.add(doc);
		documents.push(doc);
		for (const frame of Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe'))) {
			try {
				if (frame.contentDocument) {
					visit(frame.contentDocument);
				}
			} catch {}
		}
	};
	visit(rootDocument);
	return documents;
}

async function decodeDocument(doc: Document) {
	const loading = fontDecodeState.decodeLoads.get(doc);
	if (loading) {
		return loading;
	}
	const loadPromise = (async () => {
		if (!doc.body) {
			return emptyDecodeResult();
		}
		return decodeElementInPlace(doc.body);
	})().finally(() => fontDecodeState.decodeLoads.delete(doc));
	fontDecodeState.decodeLoads.set(doc, loadPromise);
	return loadPromise;
}

export async function decodeYuketangEncryptedFonts(rootDocument: Document = document) {
	const result = emptyDecodeResult();
	const unmatchedFonts = new Set<string>();
	for (const doc of getSameOriginDocuments(rootDocument)) {
		const current = await decodeDocument(doc);
		result.total += current.total;
		result.decoded += current.decoded;
		result.skipped += current.skipped;
		current.unmatchedFonts.forEach((font) => unmatchedFonts.add(font));
	}
	result.unmatchedFonts = Array.from(unmatchedFonts);
	return result;
}

function scheduleDecode(doc: Document) {
	if (fontDecodeState.timers.has(doc)) {
		return;
	}
	const hostWindow = doc.defaultView || window;
	const timer = hostWindow.setTimeout(async () => {
		fontDecodeState.timers.delete(doc);
		const result = await decodeYuketangEncryptedFonts(doc);
		if (result.decoded > 0 || result.skipped > 0) {
			console.log('[ocs:yuketang] dynamic font decode', result);
		}
	}, 100);
	fontDecodeState.timers.set(doc, timer);
}

function observeDocument(doc: Document) {
	if (fontDecodeState.observers.has(doc)) {
		return;
	}

	const registerFrames = () => {
		for (const frame of Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe'))) {
			if (!fontDecodeState.frames.has(frame)) {
				fontDecodeState.frames.add(frame);
				frame.addEventListener('load', () => {
					try {
						if (frame.contentDocument) {
							observeDocument(frame.contentDocument);
							scheduleDecode(frame.contentDocument);
						}
					} catch {}
				});
			}
			try {
				if (frame.contentDocument) {
					observeDocument(frame.contentDocument);
				}
			} catch {}
		}
	};

	const Observer = doc.defaultView?.MutationObserver || MutationObserver;
	const observer = new Observer(() => {
		registerFrames();
		scheduleDecode(doc);
	});
	fontDecodeState.observers.set(doc, observer);
	if (doc.documentElement) {
		observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
	}
	registerFrames();
}

export function observeYuketangEncryptedFonts(rootDocument: Document = document) {
	observeDocument(rootDocument);
}

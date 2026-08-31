import {
	OCSWorker,
	createDefaultQuestionResolver,
	defaultAnswerWrapperHandler,
	QuestionTypes,
	SimplifyWorkResult,
	WorkerEvents
} from '@ocsjs/core';
import { $, $elements, Project, Script, $message, $modal, $el, h, cors, $ui, CommonEventEmitter } from 'easy-us';
import { $msg, CommonWorkOptions, playMedia } from '../utils';
import { restudy, volume } from '../utils/configs';
import { waitForElement } from '../utils/study';
import { commonWork, optimizationElementWithImage, simplifyWorkResult } from '../utils/work';
import { CommonProject } from './common';
import { $console, BackgroundProject } from './background';
import { decodeYuketangEncryptedFonts, observeYuketangEncryptedFonts } from './yuketang.font';

const state = {
	study: {
		currentMedia: undefined as HTMLMediaElement | undefined
	}
};
type Leaf = {
	id: number;
	chapter_id: number;
	name: string;
	/**
	 * 0-普通章节
	 * 4-讨论
	 * 5-期末考试
	 * 6-作业
	 * 8-PPT
	 */
	leaf_type: 0 | 5;
	leaf_list?: Leaf[];
};
type ChapterList = {
	fold: boolean;
	id: number;
	name: string;
	section_leaf_list: Leaf[];
};

const changeCurrentLeafJobName = cors.defineTopFunction((name) => {
	$elements.currentScriptPanel?.body.replaceChildren(
		h('div', { className: 'card', style: { marginTop: '12px' } }, ['当前正在学习：' + name])
	);
});

export const YKTProject = Project.create({
	name: '雨课堂',
	domains: ['yuketang.cn', 'xuetangx.com'],
	scripts: {
		guide: new Script({
			name: '🖥️ 使用提示',
			matches: [
				['雨课堂课程列表', '/v2/web/index'],
				['学习内容界面', '/v2/web/studentLog'],
				['长江雨课堂手机版主页', '/m/v2/course/normalcourse/logs']
			],
			namespace: 'yuketang.study.guide',
			configs: {
				notes: {
					defaultValue: '请点击课程里面任意章节，进入学习。'
				}
			},
			oncomplete(...args) {
				// 手机版，点击视频自动检测并跳转电脑版学习
				if (location.href.includes('/m/v2/course/normalcourse/logs')) {
					$message.info('请点击任意视频，进入自动学习。');
				}
			}
		}),
		global: new Script({
			name: '全局脚本',
			matches: [['全部界面', /.*/]],
			hideInPanel: true,
			onstart(...args) {
				// 雨课堂反混淆，雨课堂修改了 attachShadow 方法
				// 这里重写removeChild方法，防止删除wrapper元素
				const _removeChild = Element.prototype.removeChild;
				Element.prototype.removeChild = function (e) {
					if (e.nodeName === 'DIV') {
						if ($elements.wrapper && e === ($elements.wrapper as Node)) {
							($elements.wrapper as HTMLElement).removeAttribute('style');
							return e;
						}
					}
					_removeChild.call(this, e);
					return e;
				};
			}
		}),
		v2_study: new Script({
			name: '📚 课程学习',
			matches: [
				['课程学习界面', '/v2/web/studentLog'],
				['课程列表', /pro\/lms\/.*\/.*\/studycontent/],
				['视频界面', 'v2/web/xcloud/video-student'],
				['视频讨论界面', /v2\/web\/lms\/.*\/forum/]
			],
			namespace: 'yuketang.study.v2',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'请点击任意小节，脚本会自动运行，并自动下一节。',
						'修改音量、倍速后请刷新页面使设置生效。',
						'⚠️ 章节测试自动答题还在开发中，请耐心等待',
						'⚠️ 手动搜题可使用官方题库的在线搜题功能： tk.enncy.cn '
					]).outerHTML
				},
				currentLeafIndex: {
					defaultValue: -1
				},
				currentStudyUrl: {
					defaultValue: ''
				},
				goNext: {
					defaultValue: false
				},
				auto: {
					label: '自动学习',
					attrs: { type: 'checkbox', title: '自动寻找未完成章节、或者自动下一节学习' },
					defaultValue: false
				},
				restudy: restudy,
				volume: volume,
				playbackRate: {
					label: '视频倍速',
					tag: 'select',
					defaultValue: 1,
					options: [
						['1', '1 x'],
						['1.25', '1.25 x'],
						['1.5', '1.5 x'],
						['2', '2.0 x']
					]
				},
				discussMode: {
					label: '讨论任务模式',
					tag: 'select',
					defaultValue: 'random' as 'random' | 'first' | 'none',
					options: [
						['random', '随机评论'],
						['first', '截取第一条评论'],
						['none', '不进行评论']
					]
				}
			},
			onhistorychange(type, ...args) {
				if (type === 'push') {
					this.oncomplete?.();
				}
			},
			async oncomplete() {
				CommonProject.scripts.render.methods.pin(this);

				if (document.location.pathname.includes('/v2/web/studentLog')) {
					const tab = await waitForElement('#tab-content');
					tab?.click();
					return;
				}

				if (document.location.pathname.includes('v2/web/xcloud/video-student')) {
					try {
						await waitForElement(
							[
								// 正常视频
								'#video-box',
								// AI学伴视频（会生成一个数字人物口型解说在视频旁）
								'.digital-human-video-element-selector'
							].join(',')
						);
						await $.sleep(2000);
						await v2_watch({
							volume: this.cfg.volume,
							playbackRate: this.cfg.playbackRate
						});
						this.cfg.goNext = true;
						$message.info('视频学习完成，即将自动进入下一节');
						setTimeout(() => {
							location.href = this.cfg.currentStudyUrl;
						}, 3000);
					} catch (e) {
						$msg.error({ content: String(e), duration: 0 });
					}
					return;
				}

				if (/v2\/web\/lms\/.*\/forum/.test(document.location.pathname)) {
					const new_discuss_list = await waitForElement('.new_discuss_list');
					const textarea = (await waitForElement('textarea.el-textarea__inner')) as HTMLTextAreaElement;
					if (!new_discuss_list || !textarea) {
						$message.error('讨论区元素加载失败，请刷新界面重试。');
						return;
					}

					const discusses = Array.from(new_discuss_list.querySelectorAll('.cont_detail'))
						.map((el) => el.textContent || '')
						.filter((text) => text.trim() !== '');

					console.log(discusses);

					if (this.cfg.discussMode === 'random') {
						const random_discuss = discusses[Math.floor(Math.random() * discusses.length)];
						textarea.value = random_discuss;
					} else if (this.cfg.discussMode === 'first') {
						textarea.value = discusses[0] || '';
					} else {
						$message.info('已设置为不进行评论，跳过评论步骤。');
						return;
					}

					// 触发输入事件
					textarea.dispatchEvent(new Event('input', { bubbles: true }));

					const submit_btn = await waitForElement('button.submitComment');
					submit_btn?.click();
					this.cfg.goNext = true;
					$message.success('评论提交成功，即将自动进入下一节');
					setTimeout(() => {
						location.href = this.cfg.currentStudyUrl;
					}, 3000);
					return;
				}

				await waitForElement('.chapter-list');
				await $.sleep(2000);

				const vue_data = document.querySelector<any>('.study-content__container').__vue__;
				const chapter_list: ChapterList[] = JSON.parse(JSON.stringify(vue_data.chapter_list || []));
				const leaf_schedules: Record<string, number> = vue_data.leaf_schedules || [];

				const leaf_list: Leaf[] = [];

				// 扁平化章节列表
				while (chapter_list.length > 0) {
					const chapter = chapter_list.shift();
					if (!chapter) break;
					while (chapter.section_leaf_list.length > 0) {
						const leaf = chapter.section_leaf_list.shift();
						if (!leaf) break;

						if (leaf.leaf_list) {
							leaf_list.push(...leaf.leaf_list);
						} else {
							leaf_list.push(leaf);
						}
					}
				}

				const getJobName = (leaf: HTMLElement) => leaf.querySelector('.leaf-title')?.textContent || '未知章节';

				const leafs = Array.from(document.querySelectorAll<HTMLElement>('.leaf-detail'));
				for (let index = 0; index < leafs.length; index++) {
					const leaf = leafs[index];
					leaf.addEventListener('click', () => {
						this.cfg.goNext = false;
						this.cfg.currentLeafIndex = index;
						this.cfg.currentStudyUrl = top?.document.location.href || '';
						const name = getJobName(leaf);
						changeCurrentLeafJobName(name);
						$console.log('正在学习：' + name);
					});
				}

				// 定位到当前小节
				const currentLeaf = leafs[this.cfg.currentLeafIndex];
				if (currentLeaf) {
					currentLeaf.scrollIntoView({ behavior: 'smooth', block: 'center' });
					changeCurrentLeafJobName(getJobName(currentLeaf));
				}

				const isLeafFinished = (leaf_index: number) => {
					const leaf_id = leaf_list[leaf_index]?.id;
					if (!leaf_id) return false;
					const schedule = leaf_schedules[leaf_id];
					return schedule === 1;
				};

				const getNext = () => {
					let index = this.cfg.currentLeafIndex;
					while (index + 1 < leafs.length) {
						index++;
						if (
							['shipin', 'taolun1' /** 'zuoye' */].some((name) =>
								leafs[index]?.querySelector(`.iconfont.icon--${name}`)
							) &&
							!isLeafFinished(index)
						) {
							break;
						}
					}
					return leafs[index];
				};

				if (this.cfg.auto) {
					const next = getNext();
					if (!next) {
						return $modal.alert({
							content: '检测到当前课程全部完成，如果还有未完成的视频请刷新重试，或者打开复习模式。'
						});
					}
					if (this.cfg.goNext) {
						const timeout = setTimeout(() => {
							next.click();
							modal?.remove();
						}, 5000);
						const modal = $modal.confirm({
							content: '5秒后即将自动继续学习：' + getJobName(next),
							cancelButtonText: '取消自动学习',
							duration: 5,
							onCancel() {
								clearTimeout(timeout);
								$message.warn({ content: '已取消自动进入下一节，后续请手动操作进入。', duration: 0 });
							}
						});
					}
				}
			}
		}),
		ai: new Script({
			name: '🤖 AI学伴',
			matches: [
				['AI学伴课程界面', '/ai-workspace/lms-graph'],
				['AI学伴课程界面手机版', '/ai-workspace/lms-graph-mobile']
			],
			namespace: 'yuketang.study.ai',
			configs: {
				notes: {
					defaultValue: '请点击任意章节，进入学习。'
				},
				restudy: restudy,
				reloadWhenError: {
					label: '黑屏自动刷新',
					attrs: { title: '视频黑屏或者检测不到视频时自动刷新页面', type: 'checkbox' },
					defaultValue: true
				},
				volume: volume,
				playbackRate: {
					label: '视频倍速',
					tag: 'select',
					defaultValue: 1,
					options: [
						['1', '1 x'],
						['1.25', '1.25 x'],
						['1.5', '1.5 x'],
						['2.0', '2.0 x']
					]
				}
			},
			async oncomplete() {
				if (location.href.includes('ai-workspace/lms-graph-mobile')) {
					await $message.warn('即将切换到电脑版AI课程...');
					await $.sleep(3000);
					location.href = location.href.replace('lms-graph-mobile', 'lms-graph');
					return;
				}

				await $.sleep(3000);
				CommonProject.scripts.render.methods.pin(this);

				// 监听音量
				this.onConfigChange('volume', (curr) => {
					state.study.currentMedia && (state.study.currentMedia.volume = curr);
				});

				// 监听速度
				this.onConfigChange('playbackRate', (curr) => {
					state.study.currentMedia && (state.study.currentMedia.playbackRate = curr);
				});

				// // 展开5次章节，确保所有章节都被展开
				const max_level = 5;
				for (let i = 0; i < max_level; i++) {
					document.querySelectorAll<HTMLElement>('.expand-icon:not(.is-expanded )').forEach((el) => el.click());
					await $.sleep(100);
				}

				const getJobs = () => Array.from(document.querySelectorAll<HTMLElement>('div.leaf-item'));
				const getJobName = () =>
					document.querySelector('.leaf-item.is-active .leaf-item-title')?.textContent || '未知任务点';
				const getNextJob = () => {
					let jobs = getJobs();
					const active_index = jobs.findIndex((job) => job.classList.contains('is-active'));

					// 不是复习模式，过滤掉已经完成的
					if (!this.cfg.restudy) {
						jobs = jobs.splice(active_index);
						jobs = jobs.filter((el) => !el.querySelector('.icon-yuanquangou'));
						jobs = jobs.filter((el) => !(el.querySelector('.leaf-item-tag')?.textContent || '').includes('自测'));
					}
					const new_active_index = jobs.findIndex((job) => job.classList.contains('is-active'));
					return jobs[new_active_index + 1];
				};

				try {
					$msg.info('等待任务加载中...');
					await waitForElement('.detail-container', {
						timeout_seconds: 10 * 1000
					});
					$msg.info('即将开始自动学习');
				} catch (e) {
					$message.error('元素加载失败，请刷新界面重试。');
				}

				const study = async () => {
					try {
						if ($el('.detail-container video')) {
							$msg.info('即将开始视频学习：' + getJobName());
							await ai_watch({
								volume: this.cfg.volume,
								playbackRate: this.cfg.playbackRate
							});
							$msg.success('视频学习完成');
							await $.sleep(3000);
						}

						if ($el('.detail-container .problem-common')) {
							$msg.warn('自测任务暂未支持，请联系作者反馈：' + getJobName());
							await $.sleep(3000);
						}
					} catch (e) {
						$message.error(`当前任务点无法完成，即将跳转下一节（${e}）`);
					}
					const next = getNextJob();
					if (!next) {
						return $modal.alert({
							content: '检测到当前视频全部播放完毕，如果还有未完成的视频请刷新重试，或者打开复习模式。'
						});
					}
					next.click();
					await $.sleep(200);
					next.scrollIntoView({ behavior: 'smooth', block: 'center' });
					await $.sleep(3000);
					study();
				};

				study();
			}
		}),
		work: new Script({
			name: '✍️ 作业考试',
			matches: [['雨课堂作业/考试页面', /\/exercise\/|\/exam\//]],
			namespace: 'yuketang.work',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'自动答题前请在 “通用-全局设置” 中设置题库配置。',
						'支持雨课堂章节练习、课堂测验和新版考试页面。',
						'开始后请核对题目、选项和答题结果，再按全局设置保存或提交。'
					]).outerHTML
				}
			},
			oncomplete() {
				if (!isYuketangWorkPage()) {
					return;
				}
				observeYuketangEncryptedFonts(document);
				commonWork(this, {
					enable_control_panel: true,
					workerProvider: (options) => workOrExam(options)
				});
			}
		}),
		'font-decrypt': new Script({
			name: '🔤 字体解密',
			matches: [
				['AI伴学自测界面', '/v2/web/iframe-self-test'],
				['AI伴学练习内嵌界面', '/v2/web/iframe-exercise'],
				['V2学习内容-作业界面', '/v2/web/cloud/student/exercise'],
				['雨课堂作业/考试页面', /\/exercise\/|\/exam\//]
			],
			async oncomplete() {
				try {
					$msg.info('正在解析雨课堂动态字体');
					observeYuketangEncryptedFonts(document);
					const result = await decodeYuketangEncryptedFonts(document);
					if (result.skipped > 0) {
						$msg.warn(`雨课堂字体哈希未命中，已保留 ${result.skipped} 个加密元素`);
					} else if (result.decoded > 0) {
						$msg.success(`字体替换完成，共处理 ${result.decoded} 个元素`);
					} else {
						console.log('[ocs:yuketang] 当前页面未检测到加密字体');
					}
				} catch (error) {
					$msg.error('字体解密失败，请刷新页面重试：' + String(error));
				}
			}
		})
	}
});

const YUKETANG_QUESTION_ROOT_SELECTOR = [
	'.container-problem',
	'.problem-common',
	'.problem-item',
	'.exam-main--content > .subject-item',
	'.exercise-item'
].join(',');

function isYuketangWorkPage() {
	if (location.hostname === 'examination.xuetangx.com') {
		return /^\/exam\//.test(location.pathname);
	}
	return (
		location.pathname.includes('/exercise/') ||
		location.pathname.includes('/iframe-exercise') ||
		location.pathname.includes('/iframe-self-test')
	);
}

function normalizeYuketangQuestionText(text: string) {
	let normalized = String(text || '').replace(/\r/g, '');
	let previous = '';
	while (normalized !== previous) {
		previous = normalized;
		normalized = normalized
			.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2')
			.replace(
				/([\u4e00-\u9fff])\s+([()\uFF08\uFF09,.\uFF0C\u3002\u3001\u201C\u201D\u300A\u300B\u3010\u3011])/g,
				'$1$2'
			)
			.replace(
				/([()\uFF08\uFF09,.\uFF0C\u3002\u3001\u201C\u201D\u300A\u300B\u3010\u3011])\s+([\u4e00-\u9fff])/g,
				'$1$2'
			);
	}
	return normalized
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ ]{2,}/g, ' ')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^(上一题|下一题|提交|交卷)$/u.test(line))
		.join('\n')
		.replace(/[\uFF08(]\s+/g, '(')
		.replace(/\s+[\uFF09)]/g, ')')
		.trim();
}

function findQuestionDocument(rootDocument: Document = document): Document {
	if (rootDocument.querySelector(YUKETANG_QUESTION_ROOT_SELECTOR)) {
		return rootDocument;
	}
	for (const iframe of Array.from(rootDocument.querySelectorAll<HTMLIFrameElement>('iframe'))) {
		try {
			if (iframe.contentDocument) {
				const candidate = findQuestionDocument(iframe.contentDocument);
				if (candidate.querySelector(YUKETANG_QUESTION_ROOT_SELECTOR)) {
					return candidate;
				}
			}
		} catch {}
	}
	return rootDocument;
}

function getYuketangQuestionRoots(targetDocument: Document = findQuestionDocument()) {
	const candidates = Array.from(targetDocument.querySelectorAll<HTMLElement>(YUKETANG_QUESTION_ROOT_SELECTOR)).filter(
		(root) =>
			Boolean(
				root.querySelector(
					'label.el-radio, label.homeworkElRadio, label.el-checkbox, label.homeworkElCheckbox, input[type="text"], textarea'
				)
			)
	);
	return candidates.filter((root) => !candidates.some((other) => other !== root && other.contains(root)));
}

function getYuketangSidebarButtons(targetDocument: Document) {
	const buttons = Array.from(
		targetDocument.querySelectorAll<HTMLElement>(
			'.problems-aside .subject-item, .subject-item.J_order, .answer-status, .question-list .btn, .nav-item, .question-nav .number'
		)
	).filter((button) => {
		const text = (button.innerText || button.textContent || '').trim();
		return text && !button.hasAttribute('disabled') && Boolean(button.offsetWidth || button.offsetHeight);
	});
	return Array.from(new Set(buttons));
}

async function waitForYuketangQuestionRoot(targetDocument: Document = findQuestionDocument(), timeout = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const root = getYuketangQuestionRoots(targetDocument)[0];
		if (root) {
			return root;
		}
		await $.sleep(200);
	}
	throw new Error('未检测到雨课堂题目容器');
}

async function prepareYuketangQuestionRoot(root: HTMLElement) {
	await decodeYuketangEncryptedFonts(root.ownerDocument || document);
	const labels = Array.from(
		root.querySelectorAll<HTMLElement>(
			'label.el-radio, label.homeworkElRadio, label.el-checkbox, label.homeworkElCheckbox'
		)
	);
	for (const label of labels) {
		if ((label.innerText || label.textContent || '').trim()) {
			continue;
		}
		const input = label.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');
		const labelElement = label.querySelector<HTMLElement>('.el-radio__label, .el-checkbox__label') || label;
		if (input?.value.toLowerCase() === 'true') {
			labelElement.append('正确');
		}
		if (input?.value.toLowerCase() === 'false') {
			labelElement.append('错误');
		}
	}
}

function extractYuketangStem(text: string) {
	let normalized = normalizeYuketangQuestionText(text)
		.replace(/^\s*\d+\.\s*(?:单选题|多选题|判断题|填空题|简答题|问答题)?\s*(?:\([^)]*\))?\s*/, '')
		.trim();
	const answerInfoIndex = normalized.search(/(本题得分|正确答案|解析[:：]?|查看解析|收起解析|已提交)/);
	if (answerInfoIndex > -1) {
		normalized = normalized.slice(0, answerInfoIndex).trim();
	}
	const lines = normalized
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const stem: string[] = [];
	for (const line of lines) {
		if (/^[A-H][\s.、:：)）]/.test(line) || /^(本题得分|正确答案|解析[:：]|查看解析|收起解析)/.test(line)) {
			break;
		}
		stem.push(line);
	}
	return stem.join(' ').trim();
}

function getYuketangQuestionTitle(root: HTMLElement) {
	const source =
		root.querySelector<HTMLElement>('.problem-body, .item-body, .question-title, .stem, .problem-title') || root;
	return (
		extractYuketangStem(source.innerText || source.textContent || '') ||
		extractYuketangStem(root.innerText || root.textContent || '')
	);
}

function createYuketangTextElement(text: string, ownerDocument: Document) {
	const element = ownerDocument.createElement('div');
	element.textContent = text;
	element.innerText = text;
	return element;
}

function getYuketangQuestionOptions(root: HTMLElement) {
	const labels = Array.from(
		root.querySelectorAll<HTMLElement>(
			'label.el-radio, label.homeworkElRadio, label.el-checkbox, label.homeworkElCheckbox'
		)
	);
	if (labels.length) {
		return labels;
	}
	return Array.from(
		root.querySelectorAll<HTMLElement>('input[type="text"], textarea, .el-input__inner, .el-textarea__inner')
	);
}

function getYuketangTextControl(option: HTMLElement) {
	if (option instanceof HTMLInputElement || option instanceof HTMLTextAreaElement) {
		return option;
	}
	return option.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		'input[type="text"], textarea, .el-input__inner, .el-textarea__inner'
	);
}

function getYuketangQuestionType(root: HTMLElement, options: HTMLElement[]): QuestionTypes {
	const typeText = normalizeYuketangQuestionText(
		root.querySelector<HTMLElement>('.item-type, .problem-type, .question-type')?.innerText || ''
	);
	if (typeText.includes('判断')) return 'judgement';
	if (typeText.includes('多选')) return 'multiple';
	if (typeText.includes('单选')) return 'single';
	if (typeText.includes('填空')) return 'completion';
	if (options.some((option) => Boolean(getYuketangTextControl(option)))) return 'completion';
	const radioCount = options.filter((option) => Boolean(option.querySelector('input[type="radio"]'))).length;
	if (radioCount) return radioCount === 2 ? 'judgement' : 'single';
	if (options.some((option) => Boolean(option.querySelector('input[type="checkbox"]')))) return 'multiple';
	return undefined;
}

function getYuketangOptionText(option: HTMLElement) {
	const input = option.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');
	let text = normalizeYuketangQuestionText(
		optimizationElementWithImage(option, true).innerText || option.textContent || ''
	);
	if (!text && input?.value.toLowerCase() === 'true') text = '正确';
	if (!text && input?.value.toLowerCase() === 'false') text = '错误';
	return text
		.replace(/^[A-H][\s.、:：)）]*/i, '')
		.replace(/^\d+[.、:：)）]*/, '')
		.trim();
}

function isYuketangOptionChecked(option: HTMLElement) {
	const input = option.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');
	return Boolean(
		input?.checked ||
			option.classList.contains('is-checked') ||
			option.querySelector('.is-checked') ||
			option.getAttribute('aria-checked') === 'true'
	);
}

function setYuketangNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const hostWindow = element.ownerDocument.defaultView || window;
	const prototype =
		element.tagName === 'TEXTAREA' ? hostWindow.HTMLTextAreaElement.prototype : hostWindow.HTMLInputElement.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
	if (descriptor?.set) {
		descriptor.set.call(element, value);
	} else {
		element.value = value;
	}
	element.dispatchEvent(new hostWindow.Event('input', { bubbles: true }));
	element.dispatchEvent(new hostWindow.Event('change', { bubbles: true }));
}

async function applyYuketangAnswer(type: QuestionTypes, answer: string, option: HTMLElement) {
	if (type === 'single' || type === 'multiple' || type === 'judgement') {
		if (!isYuketangOptionChecked(option)) {
			option.scrollIntoView({ behavior: 'smooth', block: 'center' });
			option.click();
			await $.sleep(300);
		}
		return;
	}
	if (type === 'completion' && answer.trim()) {
		const input = getYuketangTextControl(option);
		if (input) {
			input.focus();
			setYuketangNativeValue(input, answer);
			await $.sleep(200);
		}
	}
}

function yuketangTitleTransform(titles: (HTMLElement | undefined)[]) {
	return titles
		.map((title) => title?.innerText || title?.textContent || '')
		.filter(Boolean)
		.join(',')
		.trim();
}

function getDefinedYuketangElements(elements: (HTMLElement | undefined)[] | undefined) {
	return (elements || []).filter((element): element is HTMLElement => Boolean(element));
}

function createYuketangQuestionWorker(
	roots: HTMLElement[],
	options: CommonWorkOptions,
	allResults: (SimplifyWorkResult | undefined)[],
	resultOffset = 0
) {
	const { answererWrappers, period, thread, answerSeparators } = options;
	return new OCSWorker({
		root: roots,
		elements: {
			title: (root) => [
				createYuketangTextElement(getYuketangQuestionTitle(root as HTMLElement), root.ownerDocument || document)
			],
			options: (root) => getYuketangQuestionOptions(root as HTMLElement)
		},
		thread: thread ?? 1,
		answerSeparators: answerSeparators.split(',').map((separator) => separator.trim()),
		answerer: async (elements, context) => {
			const title = yuketangTitleTransform(elements.title || []);
			if (!title) {
				throw new Error('题目为空，请检查题目是否加载完成。');
			}
			const optionElements = getDefinedYuketangElements(context.elements.options);
			context.type = getYuketangQuestionType(context.root, optionElements);
			const optionText =
				context.type === 'completion' ? '' : optionElements.map((option) => getYuketangOptionText(option)).join('\n');
			return CommonProject.scripts.apps.methods.searchAnswerInCaches(title, async () => {
				await $.sleep((period ?? 3) * 1000);
				return defaultAnswerWrapperHandler(answererWrappers, {
					type: context.type || 'unknown',
					title,
					options: optionText
				});
			});
		},
		work: async (context) => {
			const optionElements = getDefinedYuketangElements(context.elements.options);
			context.type = getYuketangQuestionType(context.root, optionElements);
			if (!context.type) {
				return { finish: false, error: '题型识别失败' };
			}
			const resolver = createDefaultQuestionResolver(context)[context.type];
			if (context.type === 'completion') {
				return resolver(context.searchInfos, optionElements, applyYuketangAnswer);
			}
			return resolver(context.searchInfos, optionElements, applyYuketangAnswer);
		},
		onResultsUpdate(current, _, results) {
			const simplified = simplifyWorkResult(results, yuketangTitleTransform);
			for (let index = 0; index < simplified.length; index++) {
				allResults[resultOffset + index] = simplified[index];
			}
			CommonProject.scripts.workResults.methods.setResults(
				allResults.filter((result): result is SimplifyWorkResult => Boolean(result))
			);
			CommonProject.scripts.workResults.methods.updateWorkStateByResults(results);
			if (current.result?.finish) {
				CommonProject.scripts.apps.methods.addQuestionCacheFromWorkResult(
					simplifyWorkResult([current], yuketangTitleTransform)
				);
			}
		}
	});
}

function shouldSubmitYuketangWork(upload: CommonWorkOptions['upload'], finishedRate: number) {
	if (upload === 'nomove') return undefined;
	if (upload === 'force') return true;
	if (upload === 'save') return false;
	return Number.isFinite(Number(upload)) && finishedRate >= Number(upload);
}

function isVisibleYuketangAction(element: HTMLElement) {
	const rect = element.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

async function submitYuketangAnswer(targetDocument: Document, questionIndex: number, final: boolean) {
	const candidates = Array.from(
		targetDocument.querySelectorAll<HTMLElement>(
			'.submit-btn, .btn-submit, button.submit, .el-button--primary, .homework-submit, .paper-submit, button[type="submit"], button'
		)
	);
	const texts = final ? ['交卷', '提交'] : ['提交'];
	const button = candidates.find((candidate) => {
		const text = (candidate.innerText || candidate.textContent || '').trim();
		return (
			isVisibleYuketangAction(candidate) &&
			!candidate.hasAttribute('disabled') &&
			!/(已提交|已交|已完成)/.test(text) &&
			texts.some((expected) => text === expected || text.includes(expected))
		);
	});
	if (!button) return false;
	button.click();
	$message.info(final ? '已点击最终交卷按钮' : `第 ${questionIndex} 题已点击提交按钮`);
	for (let attempt = 0; attempt < 3; attempt++) {
		await $.sleep(attempt === 0 ? 800 : 1000);
		const dialogs = Array.from(
			targetDocument.querySelectorAll<HTMLElement>('.el-message-box, .el-dialog, [role="dialog"], .modal')
		).filter(isVisibleYuketangAction);
		const dialog = dialogs[dialogs.length - 1];
		if (!dialog) break;
		const confirmation = Array.from(dialog.querySelectorAll<HTMLElement>('button, .el-button, .btn')).find(
			(candidate) => {
				const text = (candidate.innerText || candidate.textContent || '').trim();
				return (
					isVisibleYuketangAction(candidate) &&
					!candidate.hasAttribute('disabled') &&
					/^(确定|确认|提交|交卷)$/.test(text)
				);
			}
		);
		if (!confirmation) break;
		confirmation.click();
	}
	await $.sleep(1000);
	return true;
}

async function submitYuketangWorkBySetting(options: CommonWorkOptions, results: SimplifyWorkResult[]) {
	const finishedRate = results.length ? (results.filter((result) => result.finish).length / results.length) * 100 : 0;
	const decision = shouldSubmitYuketangWork(options.upload, finishedRate);
	if (decision === undefined) return;
	if (!decision) {
		$message.info({ content: '雨课堂答题完成，已按配置保留答案不提交。', duration: 0 });
		return;
	}
	$message.info({
		content: `答题完成，将等待 ${options.stopSecondWhenFinish} 秒后尝试提交。`,
		duration: options.stopSecondWhenFinish
	});
	await $.sleep(options.stopSecondWhenFinish * 1000);
	const targetDocument = findQuestionDocument();
	if (location.pathname.includes('/exercise/')) {
		const sidebarButtons = getYuketangSidebarButtons(targetDocument);
		if (sidebarButtons.length > 1) {
			for (let index = 0; index < sidebarButtons.length; index++) {
				sidebarButtons[index].click();
				await $.sleep(500);
				await submitYuketangAnswer(findQuestionDocument(), index + 1, false);
			}
			return;
		}
	}
	await submitYuketangAnswer(targetDocument, results.length, true);
}

async function waitForYuketangWorkResume(isStopped: () => boolean, isClosed: () => boolean) {
	while (isStopped() && !isClosed()) {
		await $.sleep(200);
	}
}

function workOrExam(options: CommonWorkOptions) {
	$message.info({ content: '开始雨课堂作业/考试' });
	CommonProject.scripts.workResults.methods.init();
	const runner = new CommonEventEmitter<WorkerEvents>();
	const allResults: (SimplifyWorkResult | undefined)[] = [];
	let currentWorker: ReturnType<typeof createYuketangQuestionWorker> | undefined;
	let closed = false;
	let stopped = false;
	let done = false;
	const finish = () => {
		if (!done) {
			done = true;
			runner.emit('done');
		}
	};
	runner.once('close', () => {
		closed = true;
		currentWorker?.emit('close');
	});
	runner.on('stop', () => {
		stopped = true;
		currentWorker?.emit('stop');
	});
	runner.on('continuate', () => {
		stopped = false;
		currentWorker?.emit('continuate');
	});

	(async () => {
		try {
			runner.emit('start');
			let targetDocument = findQuestionDocument();
			let roots = getYuketangQuestionRoots(targetDocument);
			const sidebarButtons = getYuketangSidebarButtons(targetDocument);
			if (sidebarButtons.length > 1 && roots.length <= 1) {
				for (let index = 0; index < sidebarButtons.length; index++) {
					if (closed) break;
					await waitForYuketangWorkResume(
						() => stopped,
						() => closed
					);
					sidebarButtons[index].click();
					await $.sleep(800);
					targetDocument = findQuestionDocument();
					const root = await waitForYuketangQuestionRoot(targetDocument);
					await prepareYuketangQuestionRoot(root);
					currentWorker = createYuketangQuestionWorker([root], options, allResults, index);
					if (stopped) currentWorker.emit('stop');
					await currentWorker.doWork({ enable_debug: BackgroundProject.scripts.dev.cfg.enable_answerer_debug });
				}
			} else {
				if (roots.length === 0) roots = [await waitForYuketangQuestionRoot(targetDocument)];
				for (const root of roots) await prepareYuketangQuestionRoot(root);
				currentWorker = createYuketangQuestionWorker(roots, options, allResults);
				if (stopped) currentWorker.emit('stop');
				await currentWorker.doWork({ enable_debug: BackgroundProject.scripts.dev.cfg.enable_answerer_debug });
			}
			if (!closed) {
				const results = allResults.filter((result): result is SimplifyWorkResult => Boolean(result));
				await submitYuketangWorkBySetting(options, results);
				$message.success({ content: '雨课堂答题完成，请核对结果和提交状态。', duration: 0 });
			}
		} catch (error) {
			if (!closed) {
				$message.error({ content: '雨课堂答题程序发生错误：' + ((error as any)?.message || error), duration: 0 });
			}
		} finally {
			currentWorker = undefined;
			finish();
		}
	})();
	return runner;
}

/**
 * 观看视频
 * @param setting
 * @returns
 */
async function ai_watch(options: { volume: number; playbackRate: number }) {
	const set = async () => {
		// 上面操作会导致元素刷新，这里重新获取视频
		await $.sleep(1000);
		const media = (await waitForElement('.detail-container video', {
			timeout_seconds: 10 * 1000
		})) as HTMLMediaElement;
		console.log('media', media);
		await $.sleep(1000);
		state.study.currentMedia = media;

		if (media) {
			// 如果已经播放完了，则重置视频进度
			media.currentTime = 1;
			// 音量
			media.volume = options.volume;
			media.playbackRate = options.playbackRate;
		}
		return state.study.currentMedia;
	};
	$message.info('开始播放');
	const video = await set();

	if (!video) {
		throw new Error('video not found!');
	}

	return new Promise<void>((resolve, reject) => {
		const videoCheckInterval = setInterval(async () => {
			// 如果视频元素无法访问，证明已经切换了视频
			if (video?.isConnected === false) {
				clearInterval(videoCheckInterval);
				$message.info({ content: '检测到视频切换中...' });
				/**
				 * 元素无法访问证明用户切换视频了
				 * 所以不往下播放视频，而是重新播放用户当前选中的视频
				 */
				resolve();
			}
		}, 3000);

		playMedia(() => video?.play());

		video.onpause = async () => {
			if (!video?.ended) {
				await $.sleep(1000);
				video?.play();
			}
		};

		video.onended = () => {
			clearInterval(videoCheckInterval);
			// 正常切换下一个视频
			resolve();
		};
	});
}

/**
 * 观看视频
 * @param setting
 * @returns
 */
async function v2_watch(options: { volume: number; playbackRate: number }) {
	const set = async () => {
		await $.sleep(1000);

		const is_digital_human_video = !!document.querySelector('.digital-human-video-element-selector');

		if (is_digital_human_video) {
			// 成绩单里面进AI学伴会直接变成V2版本的视频，可能是雨课堂自身的BUG
			throw new Error('AI学伴视频请在学习内容中进入，不要在成绩单里进入。');
		} else {
			// 这里无法通过直接修改数值来修改倍速和音量，需要调用播放器的接口来修改
			const video_vue_data = document.querySelector<any>('.xtplayer').__vue__;
			video_vue_data.player.options.speed.value = parseFloat(options.playbackRate.toString());
			video_vue_data.player.options.volume.value = options.volume;
			// 应用更改的音量和倍速设置
			video_vue_data.player.init();
		}

		const media = (await waitForElement('video', {
			timeout_seconds: 10 * 1000
		})) as HTMLMediaElement;
		console.log('media', media);
		await $.sleep(1000);
		state.study.currentMedia = media;
		// 重置视频进度
		media.currentTime = 1;
		return state.study.currentMedia;
	};
	$message.info('开始播放');
	const video = await set();

	if (!video) {
		throw new Error('video not found!');
	}

	return new Promise<void>((resolve, reject) => {
		playMedia(() => video?.play());
		video.onpause = async () => {
			if (!video?.ended) {
				await $.sleep(1000);
				video?.play();
			}
		};
		video.onended = () => {
			// 正常切换下一个视频
			resolve();
		};
	});
}

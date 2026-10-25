// DEF-134: 要素の位置の engine の登録の時期（テストの既定の Chromium）。本体は `tests/helpers/element-path-engine-timing.ts`（Chromium ごとに別のファイル）。
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { describeElementPathEngineTiming } from '../helpers/element-path-engine-timing.js';

describeElementPathEngineTiming('the default test Chromium', () => launchHeadlessChromium());

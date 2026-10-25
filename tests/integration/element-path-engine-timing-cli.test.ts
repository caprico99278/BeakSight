// DEF-134: 要素の位置の engine の登録の時期（CLI の起動の設定の Chromium）。本体は `tests/helpers/element-path-engine-timing.ts`（Chromium ごとに別のファイル）。
import { launchCliChromium } from '../helpers/chromium.js';
import { describeElementPathEngineTiming } from '../helpers/element-path-engine-timing.js';

describeElementPathEngineTiming('the CLI Chromium', () => launchCliChromium());

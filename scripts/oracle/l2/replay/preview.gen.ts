import '../../lib/clock.setup.mjs';
import { defineReplay } from '../harness/define';

defineReplay('preview', { refused: { 4: 'DRY_RUN' } });

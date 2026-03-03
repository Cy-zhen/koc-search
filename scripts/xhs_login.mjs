import { runXiaohongshuLoginFlow } from '../server/auth/xiaohongshu-login.js';

const result = await runXiaohongshuLoginFlow();

console.log(result.message);

if (!result.success) {
  process.exit(1);
}

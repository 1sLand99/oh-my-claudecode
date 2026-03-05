import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
describe('mcp-team-bridge spawn args', () => {
    const source = readFileSync(join(__dirname, '..', 'mcp-team-bridge.ts'), 'utf-8');
    it('includes bypass approvals/sandbox and --skip-git-repo-check for Codex bridge spawns', () => {
        expect(source).toContain('"exec"');
        expect(source).toContain('"--dangerously-bypass-approvals-and-sandbox"');
        expect(source).toContain('"--skip-git-repo-check"');
    });
    it('keeps Gemini bridge spawn args with --approval-mode yolo -i', () => {
        expect(source).toContain('"--approval-mode"');
        expect(source).toContain('"yolo"');
        expect(source).toContain('"-i"');
        expect(source).toMatch(/cmd = "gemini";/);
    });
});
//# sourceMappingURL=mcp-team-bridge.spawn-args.test.js.map
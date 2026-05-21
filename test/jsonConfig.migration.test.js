'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');

describe('admin jsonConfig migration', () => {
    const repoRoot = path.join(__dirname, '..');

    it('enables jsonConfig in io-package.json', () => {
        const ioPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'io-package.json'), 'utf8'));

        expect(ioPackage.common.adminUI).to.deep.equal({ config: 'json' });
    });

    it('contains jsonConfig with expected native keys', () => {
        const jsonConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'admin/jsonConfig.json'), 'utf8'));

        expect(Object.keys(jsonConfig.items)).to.deep.equal(['baseURL', 'pollJSON', 'pollIndex', 'validationMax']);
    });

    it('removes legacy materialize admin files', () => {
        expect(fs.existsSync(path.join(repoRoot, 'admin/index_m.html'))).to.equal(false);
        expect(fs.existsSync(path.join(repoRoot, 'admin/words.js'))).to.equal(false);
    });
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');

describe('admin jsonConfig migration', () => {
    const repoRoot = path.join(__dirname, '..');
    const jsonConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'admin/jsonConfig.json'), 'utf8'));
    const translationKeys = new Set();

    const collectTranslationKeys = (entry) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }

        if (typeof entry.label === 'string') translationKeys.add(entry.label);
        if (typeof entry.help === 'string') translationKeys.add(entry.help);

        for (const value of Object.values(entry)) {
            collectTranslationKeys(value);
        }
    };

    before(() => {
        collectTranslationKeys(jsonConfig.items);
    });

    it('enables jsonConfig in io-package.json', () => {
        const ioPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'io-package.json'), 'utf8'));

        expect(ioPackage.common.adminUI).to.deep.equal({ config: 'json' });
    });

    it('contains jsonConfig with expected native keys', () => {
        expect(Object.keys(jsonConfig.items)).to.deep.equal(['baseURL', 'pollJSON', 'pollIndex', 'validationMax']);
    });

    it('removes legacy materialize admin files', () => {
        expect(fs.existsSync(path.join(repoRoot, 'admin/index_m.html'))).to.equal(false);
        expect(fs.existsSync(path.join(repoRoot, 'admin/words.js'))).to.equal(false);
    });

    it('contains synchronized i18n files for all configured languages', () => {
        const languages = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'];

        for (const language of languages) {
            const translationPath = path.join(repoRoot, `admin/i18n/${language}.json`);
            expect(fs.existsSync(translationPath), `${language} translation file is missing`).to.equal(true);

            const translations = JSON.parse(fs.readFileSync(translationPath, 'utf8'));
            const languageKeys = Object.keys(translations);

            for (const key of translationKeys) {
                expect(languageKeys).to.include(key, `${language} is missing translation key: ${key}`);
            }
        }
    });
});

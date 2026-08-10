const puppeteer = require('puppeteer-core');
const { install } = require('@puppeteer/browsers');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE_URL = 'https://www.curseforge.com/ark-survival-ascended/search';
const PAGE_SIZE = 20;

// Use current working directory for file outputs
const OUTPUT_DIR = process.cwd();
const CSV_PATH = path.join(OUTPUT_DIR, 'CCM_list.csv');
const LOG_DIR = path.join(OUTPUT_DIR, 'Change_logs');

// Determine path to system Chrome or fallback
async function resolveChromePath() {
    const systemPaths = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
    ];

    for (const chromePath of systemPaths) {
        if (fs.existsSync(chromePath)) return chromePath;
    }

    const browserPath = path.join(OUTPUT_DIR, 'chromium', 'chrome-win', 'chrome.exe');
    if (fs.existsSync(browserPath)) return browserPath;

    console.log('🌀 System Chrome not found. Downloading Chromium...');
    const browser = await install({
        browser: 'chrome',
        buildId: '116.0.5845.96',
        cacheDir: path.join(OUTPUT_DIR, 'chromium')
    });

    return browser.executablePath;
}

function parseCSV(filePath) {
    if (!fs.existsSync(filePath)) return {};

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').slice(1);
    const map = {};

    for (const line of lines) {
        if (!line.trim()) continue;
        const [name, projectId, url, updated] = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(s => s.replace(/^"|"$/g, '').trim());
        map[projectId] = { name, projectId, url, updated };
    }

    return map;
}

function saveCSV(data, filePath) {
    const csvHeader = 'Mod Name,Project ID,URL,Updated\n';
    const csvRows = data.map(mod =>
        `"${mod.name.replace(/"/g, '""')}",${mod.projectId},"${mod.url}","${mod.updated}"`
    );
    fs.writeFileSync(filePath, csvHeader + csvRows.join('\n'), 'utf8');
}

function writeChangelog(newMods, updatedMods, removedMods) {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

    const changelogPath = path.join(LOG_DIR, `changelog-${timestamp}.txt`);

    let changelog = `📅 Changelog - ${now.toLocaleString()}\n\n`;

    if (!newMods.length && !updatedMods.length && !removedMods.length) {
        changelog += '✅ No changes detected during this run.\n';
    } else {
        if (newMods.length) {
            changelog += '🆕 New Mods:\n';
            newMods.forEach(mod => {
                changelog += `- ${mod.name} [${mod.projectId}]\n  URL: ${mod.url}\n`;
            });
            changelog += '\n';
        }

        if (updatedMods.length) {
            changelog += '🔁 Updated Mods:\n';
            updatedMods.forEach(({ before, after }) => {
                changelog += `- ${after.name} [${after.projectId}]\n  Updated: ${before.updated} → ${after.updated}\n`;
            });
            changelog += '\n';
        }

        if (removedMods.length) {
            changelog += '❌ Removed Mods:\n';
            removedMods.forEach(mod => {
                changelog += `- ${mod.name} [${mod.projectId}]\n`;
            });
            changelog += '\n';
        }
    }

    const duration = ((Date.now() - global.startTime) / 1000).toFixed(2);
    changelog += `⏱️ Total scrape time: ${duration} seconds\n`;

    fs.writeFileSync(changelogPath, changelog, 'utf8');
    fs.chmodSync(changelogPath, 0o444); // Make the changelog read-only
    console.log(`📄 Changelog written to: ${changelogPath}`);
    return changelogPath;
}

const { exec } = require('child_process');

function openFile(filePath) {
    const platform = process.platform;

    if (platform === 'win32') {
        exec(`start "" "${filePath}"`);
    } else if (platform === 'darwin') {
        exec(`open "${filePath}"`);
    } else {
        exec(`xdg-open "${filePath}"`);
    }
}

async function scrapeModDetails(browser, mod) {
    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
        await page.goto(mod.url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('body', { visible: true, timeout: 10000 });

        // Give CurseForge a short moment to hydrate the details panel.
        await new Promise(resolve => setTimeout(resolve, 750));

        const details = await page.evaluate(() => {
            const result = { projectId: 'Not Found', updated: 'Not Found' };

            function clean(text) {
                return (text || '').replace(/\s+/g, ' ').trim();
            }

            function isAbsoluteDate(text) {
                return /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i.test(text || '');
            }

            function firstAbsoluteDate(text) {
                const match = (text || '').match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i);
                return match ? match[0] : '';
            }

            // Old CurseForge layout: <dt>Project ID</dt><dd>...</dd>
            const dtElements = document.querySelectorAll('dt');
            for (let i = 0; i < dtElements.length; i++) {
                const label = clean(dtElements[i].textContent).replace(/:$/, '');
                const dd = dtElements[i].nextElementSibling;
                if (!dd) continue;

                if (label === 'Project ID') {
                    const span = dd.querySelector('.project-id');
                    const text = span ? clean(span.textContent) : clean(dd.textContent);
                    const match = text.match(/\d+/);
                    if (match) result.projectId = match[0];
                }

                if (label === 'Updated') {
                    const span = dd.querySelector('span');
                    const text = span ? clean(span.textContent) : clean(dd.textContent);
                    if (text) result.updated = text;
                }
            }

            // New CurseForge layout fallback: visible text lines like:
            // Details / Downloads: / Created: / Updated: / 11 months ago / Project ID: / 972253
            const lines = (document.body.innerText || '')
                .split('\n')
                .map(line => clean(line))
                .filter(Boolean);

            function valueAfterLabel(label) {
                const wanted = label.toLowerCase().replace(/:$/, '');
                for (let i = 0; i < lines.length; i++) {
                    const current = lines[i].toLowerCase().replace(/:$/, '');
                    if (current === wanted) {
                        for (let j = i + 1; j < lines.length; j++) {
                            const candidate = lines[j];
                            if (candidate) return candidate;
                        }
                    }
                }
                return '';
            }

            if (result.projectId === 'Not Found') {
                const projectIdLine = valueAfterLabel('Project ID');
                const match = projectIdLine.match(/\d+/);
                if (match) result.projectId = match[0];
            }

            if (result.updated === 'Not Found') {
                const updatedLine = valueAfterLabel('Updated');
                if (updatedLine) result.updated = updatedLine;
            }

            // If any detail text contains an absolute date, prefer it over relative text such as "11 months ago".
            const absoluteDate = firstAbsoluteDate(document.body.innerText || '');
            if (absoluteDate && (!isAbsoluteDate(result.updated) || /ago$/i.test(result.updated))) {
                result.updated = absoluteDate;
            }

            return result;
        });

        // Prefer the absolute date from the search result card when available.
        // The project detail page now often shows relative dates such as "11 months ago".
        if (mod.updatedFromList && (!details.updated || details.updated === 'Not Found' || /ago$/i.test(details.updated))) {
            details.updated = mod.updatedFromList;
        }

        return { ...mod, ...details };
    } catch (err) {
        console.error(`❌ Failed to scrape: ${mod.name}`, err);
        return null;
    } finally {
        await page.close();
    }
}

async function run() {
    global.startTime = Date.now();
    const executablePath = await resolveChromePath();

    const browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    );

    page.setDefaultNavigationTimeout(60000);

    const existingMods = parseCSV(CSV_PATH);
    const updatedModsMap = { ...existingMods };
    const scrapedModsMap = {};
    const newMods = [];
    const updatedMods = [];

    await page.goto(`${BASE_URL}?page=1&pageSize=${PAGE_SIZE}&sortBy=relevancy&class=mods&categories=custom-cosmetics`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a.name[href^="/ark-survival-ascended/mods/"]', { visible: true, timeout: 30000 });

    const totalPages = await page.evaluate((pageSize) => {
        const bodyText = document.body.innerText || '';

        // Current CurseForge format: "1 of 39"
        const ofMatch = bodyText.match(/\b\d+\s+of\s+(\d+)\b/i);
        if (ofMatch) {
            const pages = parseInt(ofMatch[1], 10);
            if (!isNaN(pages) && pages > 0) return pages;
        }

        // Fallback: "765 Projects" / 20 per page = 39 pages
        const projectsMatch = bodyText.match(/([\d,]+)\s+Projects/i);
        if (projectsMatch) {
            const totalProjects = parseInt(projectsMatch[1].replace(/,/g, ''), 10);
            if (!isNaN(totalProjects) && totalProjects > 0) {
                return Math.ceil(totalProjects / pageSize);
            }
        }

        // Last-resort fallback. This should only happen if CurseForge changes markup again.
        return 1;
    }, PAGE_SIZE);

    console.log(`📄 Detected ${totalPages} total pages.`);

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const pageUrl = `${BASE_URL}?page=${pageNum}&pageSize=${PAGE_SIZE}&sortBy=relevancy&class=mods&categories=custom-cosmetics`;
        console.log(`\n🌐 Scraping Page ${pageNum}: ${pageUrl}`);
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

        try {
            await page.waitForSelector('a.name[href^="/ark-survival-ascended/mods/"]', { visible: true, timeout: 15000 });
        } catch (err) {
            console.log(`🛑 No mods found or timeout on page ${pageNum}. Ending early.`);
            break;
        }

        const mods = await page.evaluate(() => {
            const dateRegex = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i;
            const modAnchors = document.querySelectorAll('a.name[href^="/ark-survival-ascended/mods/"]');

            return Array.from(modAnchors)
                .map(a => {
                    const nameSpan = a.querySelector('span.ellipsis');
                    const name = nameSpan?.textContent.trim() || a.textContent.trim();

                    let updatedFromList = '';
                    let node = a;
                    for (let i = 0; i < 10 && node; i++) {
                        const text = node.innerText || '';
                        const match = text.match(dateRegex);
                        if (match) {
                            updatedFromList = match[0];
                            break;
                        }
                        node = node.parentElement;
                    }

                    return {
                        name,
                        url: 'https://www.curseforge.com' + a.getAttribute('href'),
                        updatedFromList
                    };
                })
                .filter(mod =>
                    mod.name &&
                    mod.name.toLowerCase() !== 'copy to clipboard' &&
                    mod.url.includes('/ark-survival-ascended/mods/')
                );
        });

        if (mods.length === 0) {
            console.log(`🛑 No mods found on page ${pageNum}. Ending early.`);
            break;
        }

        const modDetailsPromises = mods.map(mod => scrapeModDetails(browser, mod));
        const detailedMods = (await Promise.all(modDetailsPromises)).filter(Boolean);

        for (const mod of detailedMods) {
            scrapedModsMap[mod.projectId] = true;
            const existing = existingMods[mod.projectId];

            if (!existing) {
                console.log(`🆕 New mod: ${mod.name}`);
                newMods.push(mod);
                updatedModsMap[mod.projectId] = mod;
            } else if (mod.updated !== existing.updated) {
                console.log(`🔁 Updated mod: ${mod.name} (was ${existing.updated}, now ${mod.updated})`);
                updatedMods.push({ before: existing, after: mod });
                updatedModsMap[mod.projectId] = mod;
            } else {
                console.log(`⏩ Skipping unchanged mod: ${mod.name}`);
            }
        }
    }

    await browser.close();

    const removedMods = Object.values(existingMods).filter(mod => !scrapedModsMap[mod.projectId]);

    const updatedList = Object.values(updatedModsMap).sort((a, b) => a.name.localeCompare(b.name));
    saveCSV(updatedList, CSV_PATH);
    const changelogPath = writeChangelog(newMods, updatedMods, removedMods);

    console.log(`\n✅ CSV updated with ${updatedList.length} total entries.`);

    openFile(CSV_PATH);
    openFile(changelogPath);
}

const readline = require('readline');

// Place this at the VERY END of your scraper.js, after all function definitions

(async () => {
    try {
        await run();
    } catch (err) {
        console.error('FATAL ERROR:', err && err.stack ? err.stack : err);

        // Always pause for user input, works even on double-click
        if (process.platform === 'win32') {
            try {
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                rl.question('Press Enter to exit...', () => {
                    rl.close();
                    process.exit(1);
                });
                // Prevent the program from exiting before user presses Enter
                return;
            } catch (e) {
                // If for some reason readline fails, just exit
            }
        }

        process.exit(1);
    }
})();


//run();

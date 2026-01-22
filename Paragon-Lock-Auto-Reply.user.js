// ==UserScript==
// @name         Paragon Lock & Auto-Reply (V5.0 Custom)
// @namespace    https://github.com/sandeep030502/tampermonkey-scripts
// @version      5.0
// @description  Lock -> Reply -> Select WIP -> Text -> Review -> Send
// @author       Sandeep
// @match        https://paragon-na.amazon.com/hz/view-case*
//
// @updateURL    https://raw.githubusercontent.com/sandeep030502/tampermonkey-scripts/main/Paragon-Lock-Auto-Reply.user.js
// @downloadURL  https://raw.githubusercontent.com/sandeep030502/tampermonkey-scripts/main/Paragon-Lock-Auto-Reply.user.js
//
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const REPLY_TEXT = `Hello,

Please be noted that we have received your request . We are working on it Please standby

Thank you`;

    // --- SELECTORS ---
    const SEL = {
        LOCK_KEYWORD: "Lock",
        REPLY_BTN_TEXT: "Reply",
        REVIEW_BTN_TEXT: "Review",
        SEND_BTN_TEXT: "Send",
        // The text area inside the composer
        TEXT_AREA: "textarea[placeholder='Insert email body here']",
        // The Work-in-Progress Radio Button (Targeting the custom element attributes)
        WIP_RADIO: "kat-radiobutton[value='Work-in-Progress']"
    };

    // --- HELPER FUNCTIONS ---

    function safeInputText(element, text) {
        if (!element) return;
        element.focus();
        try {
            const success = document.execCommand('insertText', false, text);
            if (!success) throw new Error("execCommand failed");
        } catch (e) {
            element.value = text;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function getElementByText(text) {
        return document.evaluate(
            `//*[(self::button or self::a or self::span) and contains(., '${text}')]`,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
        ).singleNodeValue;
    }

    function waitFor(conditionFunc, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const result = conditionFunc();
                if (result) resolve(result);
                else if (Date.now() - start > timeout) reject(new Error("Timeout waiting for element"));
                else requestAnimationFrame(check);
            };
            check();
        });
    }

    // --- MAIN AUTOMATION LOGIC ---

    async function runAutomationSequence() {
        console.log(">> 🚀 Automation sequence started...");

        try {
            // STEP 1: Smart Reply Check
            // Check if text area is ALREADY visible (common in Pending cases)
            let textArea = document.querySelector(SEL.TEXT_AREA);

            if (!textArea) {
                console.log(">> Text area not found. Clicking 'Reply' button...");
                const replyBtn = await waitFor(() => getElementByText(SEL.REPLY_BTN_TEXT));
                await new Promise(r => setTimeout(r, 800)); // Wait for Lock transition
                replyBtn.click();

                // Wait for text area to appear
                textArea = await waitFor(() => document.querySelector(SEL.TEXT_AREA));
            } else {
                console.log(">> ⚡ Text area already visible. Skipping 'Reply' click.");
            }

            // STEP 2: Select "Work-in-Progress"
            // We wait a moment for the radio buttons to render
            await new Promise(r => setTimeout(r, 500));
            const wipBtn = document.querySelector(SEL.WIP_RADIO);
            if (wipBtn) {
                wipBtn.click();
                console.log(">> ✅ Selected 'Work-in-Progress'");
            } else {
                console.warn(">> ⚠️ Could not find 'Work-in-Progress' button. Continuing...");
            }

            // STEP 3: Insert Text
            await new Promise(r => setTimeout(r, 500));
            safeInputText(textArea, REPLY_TEXT);

            // STEP 4: Click REVIEW
            const reviewBtn = await waitFor(() => getElementByText(SEL.REVIEW_BTN_TEXT));
            await new Promise(r => setTimeout(r, 500));
            reviewBtn.click();

            // STEP 5: Click SEND
            const sendBtn = await waitFor(() => getElementByText(SEL.SEND_BTN_TEXT));
            await new Promise(r => setTimeout(r, 1000));
            sendBtn.click();
            console.log(">> ✅ Sequence Complete.");

        } catch (e) {
            console.error(">> ❌ Automation failed:", e);
            alert("Automation Failed: " + e.message);
        }
    }

    // --- UI: FLOATING BUTTON (BACKUP) ---
    // Useful if "Lock Case" button is missing or behaves oddly
    function createFloatingButton() {
        if (document.getElementById('paragon-auto-reply-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'paragon-auto-reply-btn';
        btn.innerText = '⚡ Auto Reply';
        Object.assign(btn.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: '9999',
            padding: '10px 20px', backgroundColor: '#007185', color: 'white',
            border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold',
            boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
        });
        btn.onclick = (e) => { e.preventDefault(); runAutomationSequence(); };
        document.body.appendChild(btn);
    }

    // --- INITIALIZATION ---

    createFloatingButton();

    const observer = new MutationObserver(() => {
        createFloatingButton(); // Keep floating button alive

        // Find any element containing "Lock" (Button or Link)
        const lockBtn = getElementByText(SEL.LOCK_KEYWORD);

        if (lockBtn && !lockBtn.dataset.hasAutoReplyListener) {
            lockBtn.dataset.hasAutoReplyListener = "true";
            lockBtn.addEventListener('click', (e) => {
                // Verify text is still "Lock" (not Release)
                const currentText = (e.currentTarget.textContent || "").trim();
                if (!currentText.includes(SEL.LOCK_KEYWORD)) return;
                runAutomationSequence();
            });
            console.log(">> 🟢 Listener attached to Lock button.");
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();

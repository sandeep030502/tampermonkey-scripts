// ==UserScript==
// @name         Paragon Lock & Auto-Reply
// @namespace    https://github.com/sandeep030502/tampermonkey-scripts
// @version      3.2
// @description  Automates the Lock Case -> Reply -> Review -> Send workflow on Paragon
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
We have received your request please standby we are working on it.
Thank you`;

    // --- SELECTORS ---
    const SEL = {
        LOCK_BTN_TEXT: "Lock Case",
        REPLY_BTN_TEXT: "Reply",
        REVIEW_BTN_TEXT: "Review",
        SEND_BTN_TEXT: "Send",
        TEXT_AREA: "#composer > kat-card:nth-child(3) > div:nth-child(6) > div.textarea-container.component.outbound-textbox > div:nth-child(1) > textarea"
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

    function getButtonByText(text) {
        return document.evaluate(
            `//button[contains(., '${text}')]`,
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

    // --- MAIN LOGIC ---

    async function runAutomationSequence() {
        console.log(">> 🔒 Automation sequence started...");

        try {
            // STEP 1: Wait for Reply button
            const replyBtn = await waitFor(() => getButtonByText(SEL.REPLY_BTN_TEXT));
            await new Promise(r => setTimeout(r, 800)); 
            replyBtn.click();

            // STEP 2: Wait for Text Area
            const textArea = await waitFor(() => document.querySelector(SEL.TEXT_AREA));
            await new Promise(r => setTimeout(r, 500)); 
            safeInputText(textArea, REPLY_TEXT);

            // STEP 3: Click REVIEW
            const reviewBtn = await waitFor(() => getButtonByText(SEL.REVIEW_BTN_TEXT));
            await new Promise(r => setTimeout(r, 500));
            reviewBtn.click();

            // STEP 4: Click SEND
            const sendBtn = await waitFor(() => getButtonByText(SEL.SEND_BTN_TEXT));
            await new Promise(r => setTimeout(r, 1000)); 
            sendBtn.click();
            console.log(">> ✅ Sequence Complete.");

        } catch (e) {
            console.error(">> ❌ Automation failed:", e);
        }
    }

    // --- INITIALIZATION ---
    
    const observer = new MutationObserver(() => {
        const lockBtn = getButtonByText(SEL.LOCK_BTN_TEXT);
        
        // We check if the button exists and hasn't been tagged yet
        if (lockBtn && !lockBtn.dataset.hasAutoReplyListener) {
            lockBtn.dataset.hasAutoReplyListener = "true";
            
            lockBtn.addEventListener('click', (e) => {
                // BUG FIX: Check if the button text is actually "Lock Case" right now.
                // If the text has changed to "Release Case", this will be false, and we stop.
                const currentText = e.currentTarget.textContent || "";
                if (!currentText.includes(SEL.LOCK_BTN_TEXT)) {
                    console.log(">> Clicked button is NOT 'Lock Case' (probably Release). Stopping automation.");
                    return; 
                }
                
                runAutomationSequence();
            });
            
            console.log(">> 🟢 Script active: Listener attached to Lock Case button.");
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();

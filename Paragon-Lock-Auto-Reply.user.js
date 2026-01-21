// ==UserScript==
// @name         Paragon Lock & Auto-Reply (Smart V4.1)
// @namespace    https://github.com/sandeep030502/tampermonkey-scripts
// @version      4.1
// @description  Automates Lock -> Reply -> Review -> Send (Works on Pending & Unassigned)
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
        // We look for "Lock" to capture "Lock Case"
        LOCK_KEYWORD: "Lock", 
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

    // Finds button OR anchor tag with specific text
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
            // STEP 1: Check if Reply Box is ALREADY Open
            // On Pending cases, the box might already be there. If so, skip clicking 'Reply'.
            let textArea = document.querySelector(SEL.TEXT_AREA);
            
            if (!textArea) {
                console.log(">> Text area not found. Clicking 'Reply' button...");
                const replyBtn = await waitFor(() => getElementByText(SEL.REPLY_BTN_TEXT));
                await new Promise(r => setTimeout(r, 800)); // Wait for Lock transition
                replyBtn.click();
                
                // Now wait for text area to appear
                textArea = await waitFor(() => document.querySelector(SEL.TEXT_AREA));
            } else {
                console.log(">> ⚡ Text area already visible. Skipping 'Reply' click.");
            }

            // STEP 2: Insert Text
            await new Promise(r => setTimeout(r, 500)); 
            safeInputText(textArea, REPLY_TEXT);

            // STEP 3: Click REVIEW
            const reviewBtn = await waitFor(() => getElementByText(SEL.REVIEW_BTN_TEXT));
            await new Promise(r => setTimeout(r, 500));
            reviewBtn.click();

            // STEP 4: Click SEND
            const sendBtn = await waitFor(() => getElementByText(SEL.SEND_BTN_TEXT));
            await new Promise(r => setTimeout(r, 1000)); 
            sendBtn.click();
            console.log(">> ✅ Sequence Complete.");

        } catch (e) {
            console.error(">> ❌ Automation failed:", e);
        }
    }

    // --- INITIALIZATION ---
    
    const observer = new MutationObserver(() => {
        // Look for any element containing "Lock Case" (Button, Anchor, or Span)
        const lockBtn = getElementByText(SEL.LOCK_KEYWORD + " Case");
        
        if (lockBtn && !lockBtn.dataset.hasAutoReplyListener) {
            // We found a "Lock Case" button. Attach the listener.
            lockBtn.dataset.hasAutoReplyListener = "true";
            
            lockBtn.addEventListener('click', (e) => {
                // SAFETY CHECK: verify the text still says "Lock" when clicked.
                // This prevents running if the button turned into "Release".
                const currentText = (e.currentTarget.textContent || "").trim();
                
                if (!currentText.includes(SEL.LOCK_KEYWORD)) {
                    console.log(`>> Clicked button text is '${currentText}'. Stopping (not Lock).`);
                    return; 
                }
                
                // If it IS "Lock Case", run the script
                runAutomationSequence();
            });
            
            console.log(">> 🟢 Script active: Listener attached to Lock Case button.");
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();

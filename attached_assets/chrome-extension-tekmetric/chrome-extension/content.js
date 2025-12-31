console.log("Tekmetric Job Importer: Content script loaded (v3.15.0)");

let checkHistoryButton = null;
let injectedIcons = new Set(); // Track which textareas already have icons

// ==================== LABOR RATE UI REFRESH HANDLER ====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "REFRESH_LABOR_RATE_UI") {
    console.log("[Labor Rate] Refreshing UI after rate update to:", msg.rate, msg.groupName);
    
    // Create overlay with update message
    const overlay = document.createElement("div");
    overlay.id = "labor-rate-overlay";
    overlay.innerHTML = `
      <div style="text-align: center;">
        <div style="font-size: 1.5em; margin-bottom: 10px;">Updating labor rate...</div>
        <div style="font-size: 1em; opacity: 0.8;">${msg.groupName || 'Matched Group'}: $${((msg.rate || 0) / 100).toFixed(2)}/hr</div>
      </div>
    `;
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      background: "rgba(0,0,0,0.7)",
      color: "white",
      fontSize: "1.5em",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "99999"
    });
    document.body.appendChild(overlay);

    // Reload page after brief delay
    setTimeout(() => {
      window.location.reload();
    }, 1000);
    
    sendResponse({ success: true });
    return false; // Only return false when we handled it
  }
  // Don't return anything if we didn't handle it - let other listeners process
});

// Remove overlay after reload (if it exists from previous page)
window.addEventListener("load", () => {
  const overlay = document.getElementById("labor-rate-overlay");
  if (overlay) {
    overlay.remove();
  }
});
// ==================== END LABOR RATE HANDLER ====================

// ==================== JOB CREATED VIA API HANDLER ====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "JOB_CREATED_VIA_API") {
    console.log("[Job API] Job created notification:", msg.jobId, msg.jobName);
    
    // Show success overlay briefly
    const overlay = document.createElement("div");
    overlay.id = "job-created-overlay";
    overlay.innerHTML = `
      <div style="text-align: center;">
        <div style="font-size: 2em; margin-bottom: 10px;">&#10004;</div>
        <div style="font-size: 1.5em; margin-bottom: 10px;">Job Created!</div>
        <div style="font-size: 1em; opacity: 0.8;">${msg.jobName || 'New Job'}</div>
      </div>
    `;
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      background: "rgba(0, 100, 0, 0.85)",
      color: "white",
      fontSize: "1.5em",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "99999"
    });
    document.body.appendChild(overlay);

    // Remove overlay after brief display (page will reload from sidepanel)
    setTimeout(() => {
      overlay.remove();
    }, 1500);
    
    sendResponse({ success: true });
    return false; // Only return false when we handled it
  }
  // Don't return anything if we didn't handle it - let other listeners process
});
// ==================== END JOB CREATED HANDLER ====================

function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(selector)) {
      return resolve(document.querySelector(selector));
    }

    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve(document.querySelector(selector));
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${selector}`));
    }, timeout);
  });
}

// Wait for Job modal to appear after clicking Job button
function waitForModal(timeout = 15000) {
  console.log('⏳ Waiting for Job modal to appear...');
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkForModal = () => {
      // Look for modal dialog or any container with text inputs
      // Modal appears fast, just need to find it
      const dialogs = document.querySelectorAll('[role="dialog"], .modal, [class*="Modal"], [class*="dialog"]');
      
      for (const dialog of dialogs) {
        // Check if dialog has input fields (job name field)
        const inputs = dialog.querySelectorAll('input, textarea, [contenteditable="true"]');
        if (inputs.length >= 1) {
          const elapsed = Date.now() - startTime;
          console.log(`✓ Found modal with ${inputs.length} input fields (${elapsed}ms)`);
          return resolve(dialog);
        }
      }
      
      // Fallback: Look for any container with multiple inputs that appeared recently
      const allContainers = document.querySelectorAll('div[style*="z-index"], section');
      for (const container of allContainers) {
        const zIndex = parseInt(window.getComputedStyle(container).zIndex) || 0;
        if (zIndex > 100) {
          const inputs = container.querySelectorAll('input, textarea, [contenteditable="true"]');
          if (inputs.length >= 1 && inputs.length < 200) {
            const elapsed = Date.now() - startTime;
            console.log(`✓ Found high z-index container with ${inputs.length} inputs (${elapsed}ms)`);
            return resolve(container);
          }
        }
      }
      
      // Check if timeout exceeded
      const elapsed = Date.now() - startTime;
      if (elapsed > timeout) {
        console.log('⚠️ Modal detection timed out, using document.body as fallback');
        return resolve(document.body);
      }
      
      // Log progress every 1 second
      if (elapsed % 1000 < 100) {
        console.log(`⏳ Still waiting for modal... (${Math.floor(elapsed / 1000)}s elapsed)`);
      }
      
      // Keep polling every 100ms
      setTimeout(checkForModal, 100);
    };
    
    // Start checking immediately
    checkForModal();
  });
}

// Set value on React-controlled input elements
// This technique works with React apps by using the native value setter
function setNativeInputValue(element, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
  const prototype = Object.getPrototypeOf(element);
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(element, value);
  } else if (valueSetter) {
    valueSetter.call(element, value);
  } else {
    element.value = value;
  }

  // Dispatch events to ensure React sees the change
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
}

function fillInput(selector, value) {
  const element = document.querySelector(selector);
  if (!element) return false;
  
  element.focus();
  setNativeInputValue(element, value);
  
  return true;
}

function clickElement(selector) {
  const element = document.querySelector(selector);
  if (!element) return false;
  
  element.click();
  return true;
}

let isFillingJob = false;

async function fillTekmetricEstimate(jobData) {
  if (isFillingJob) {
    console.log("⏸️ Already filling a job, skipping duplicate request");
    return;
  }
  
  isFillingJob = true;
  console.log("🚀 Starting to fill Tekmetric estimate with job data:", jobData);
  
  // CRITICAL: Clear job data immediately to prevent duplicate runs
  chrome.runtime.sendMessage({ action: "CLEAR_PENDING_JOB" }, () => {
    console.log("🧹 Cleared pending job data from storage");
  });
  
  try {
    console.log("1️⃣ Checking if on Tekmetric page...");
    console.log("Current URL:", window.location.href);
    
    if (!window.location.href.includes('shop.tekmetric.com')) {
      console.log("❌ Not on Tekmetric page, skipping auto-fill");
      isFillingJob = false;
      return;
    }
    
    console.log("✅ On Tekmetric page, starting automation immediately...");
    // No artificial delay needed - page is already loaded when user switches to tab
    // Chrome throttles setTimeout in background tabs, causing 2.5min+ delays

    const jobButton = Array.from(document.querySelectorAll('button')).find(btn => {
      const icon = btn.querySelector('svg');
      return btn.textContent.trim() === 'Job' || (icon && btn.getAttribute('aria-label')?.includes('Job'));
    });
    
    if (!jobButton) {
      isFillingJob = false;
      throw new Error('Could not find Job button. Make sure you are on the Estimate tab.');
    }
    
    console.log('✓ Clicking Job button...');
    jobButton.click();
    
    console.log('3️⃣ Waiting for Job modal to fully render...');
    // Use waitForModal to explicitly wait for the dialog to render (can take 10-12 seconds!)
    const modal = await waitForModal(); // Uses default 15 second timeout
    
    console.log('✓ Found modal:', {tag: modal.tagName, role: modal.getAttribute('role'), className: modal.className});
    console.log('4️⃣ Searching for inputs INSIDE the modal only...');
    
    // Search for inputs ONLY inside the modal
    const modalInputs = Array.from(modal.querySelectorAll('input'));
    const modalTextareas = Array.from(modal.querySelectorAll('textarea'));
    const modalContentEditables = Array.from(modal.querySelectorAll('[contenteditable]'));
    
    console.log(`Found ${modalInputs.length} inputs, ${modalTextareas.length} textareas, ${modalContentEditables.length} contenteditable in modal`);
    console.log('Modal inputs:', modalInputs.map(i => ({tag: 'INPUT', type: i.type, value: i.value, placeholder: i.placeholder, id: i.id, name: i.name})));
    console.log('Modal textareas:', modalTextareas.map(t => ({tag: 'TEXTAREA', value: t.value, placeholder: t.placeholder})));
    console.log('Modal contentEditables:', modalContentEditables.map(c => ({tag: c.tagName, text: c.textContent})));
    
    // Try to find job name field
    let jobNameInput = null;
    
    // Strategy 1: Look for empty textarea first
    jobNameInput = modalTextareas.find(t => !t.value);
    
    // Strategy 2: Look for empty contenteditable
    if (!jobNameInput) {
      jobNameInput = modalContentEditables.find(c => 
        c.contentEditable && 
        c.contentEditable !== 'false' &&
        !c.textContent.trim()
      );
    }
    
    // Strategy 3: Look for ANY text-like input (exclude checkboxes, radios, hidden)
    if (!jobNameInput) {
      jobNameInput = modalInputs.find(i => 
        !i.value &&
        i.type !== 'hidden' &&
        i.type !== 'checkbox' &&
        i.type !== 'radio' &&
        !i.placeholder?.toLowerCase().includes('search')
      );
    }
    
    // Strategy 4: If still nothing, just use the FIRST visible text input
    if (!jobNameInput) {
      jobNameInput = modalInputs.find(i => 
        i.type !== 'hidden' &&
        i.type !== 'checkbox' &&
        i.type !== 'radio'
      );
    }
    
    if (!jobNameInput) {
      console.error('❌ Job name field not found');
      console.log('Tried textareas, contenteditable divs, and text inputs');
      isFillingJob = false;
      throw new Error('Could not find job name field after clicking Job button');
    }
    
    console.log('✓ Found job name field:', {
      tagName: jobNameInput.tagName,
      type: jobNameInput.type,
      id: jobNameInput.id,
      className: jobNameInput.className,
      contentEditable: jobNameInput.contentEditable,
      placeholder: jobNameInput.placeholder
    });
    console.log('✓ Filling job name:', jobData.jobName);
    
    try {
      // Check if it's a contenteditable element or an input
      if (jobNameInput.contentEditable === 'true') {
        console.log('Using contenteditable approach...');
        jobNameInput.focus();
        jobNameInput.textContent = jobData.jobName;
        jobNameInput.dispatchEvent(new Event('input', { bubbles: true }));
        jobNameInput.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (jobNameInput.tagName === 'INPUT' || jobNameInput.tagName === 'TEXTAREA') {
        console.log('Using setNativeInputValue for React compatibility...');
        jobNameInput.focus();
        setNativeInputValue(jobNameInput, jobData.jobName);
      } else {
        console.log('Using simple typing simulation...');
        jobNameInput.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, jobData.jobName);
      }
      
      await new Promise(resolve => setTimeout(resolve, 200));
      console.log('✓ Job name filled successfully');
    } catch (err) {
      console.error('❌ Error filling job name:', err);
      throw err;
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));

    // NEW WORKFLOW: No Save needed! Immediately click "Add Labor" button in modal
    console.log('🆕 Looking for "Add Labor" button in modal (no Save needed!)...');
    
    for (const laborItem of jobData.laborItems) {
      console.log(`\n📋 Adding labor item: ${laborItem.name}`);
      
      // Find "Add Labor" button in the modal
      const addLaborButton = Array.from(document.querySelectorAll('button')).find(btn => {
        const text = btn.textContent.trim().toLowerCase();
        return text.includes('add labor') || text === 'labor';
      });
      
      if (!addLaborButton) {
        console.error('❌ "Add Labor" button not found in modal');
        console.log('Available buttons:', Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()));
        isFillingJob = false;
        throw new Error('Could not find "Add Labor" button');
      }
      
      // Snapshot inputs BEFORE clicking to detect new ones
      const inputsBefore = new Set(document.querySelectorAll('input:not([type="hidden"]), textarea'));
      
      console.log('✓ Clicking "Add Labor" button');
      addLaborButton.click();
      await new Promise(resolve => setTimeout(resolve, 1500)); // Wait for UI to fully render

      // Find NEW inputs that appeared after the click
      const inputsAfter = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea'));
      const newInputs = inputsAfter.filter(inp => !inputsBefore.has(inp));
      
      console.log(`✓ Detected ${newInputs.length} new input fields after clicking Add Labor`);
      
      if (newInputs.length === 0) {
        console.error('❌ No new inputs detected after Add Labor click');
        isFillingJob = false;
        throw new Error('Add Labor did not create new input fields - UI may have changed');
      }

      const inputs = newInputs;
      
      // Find labor description field - be VERY specific to avoid part fields
      const descriptionField = inputs.find(inp => {
        const placeholder = inp.placeholder?.toLowerCase() || '';
        const label = inp.getAttribute('aria-label')?.toLowerCase() || '';
        const name = inp.name?.toLowerCase() || '';
        const id = inp.id?.toLowerCase() || '';
        
        // MUST contain description/labor keywords AND NOT contain part/brand/number keywords
        const hasLaborKeyword = placeholder.includes('description') || 
                                label.includes('description') ||
                                placeholder.includes('labor') || 
                                label.includes('labor') || 
                                name.includes('labor') ||
                                name.includes('description');
        
        const hasPartKeyword = placeholder.includes('part') || 
                              label.includes('part') ||
                              name.includes('part') ||
                              placeholder.includes('brand') ||
                              name.includes('brand') ||
                              placeholder.includes('number') ||
                              id.includes('part');
        
        return hasLaborKeyword && !hasPartKeyword;
      });
      
      if (!descriptionField) {
        console.error('❌ Labor description field not found');
        console.log('Available inputs:', inputs.map(i => ({
          tag: i.tagName, 
          type: i.type, 
          placeholder: i.placeholder, 
          label: i.getAttribute('aria-label'),
          name: i.name
        })));
        isFillingJob = false;
        throw new Error('Could not find labor description field');
      }
      
      // Use setNativeInputValue for React compatibility
      descriptionField.focus();
      await new Promise(resolve => setTimeout(resolve, 200));
      setNativeInputValue(descriptionField, laborItem.name);
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait to ensure React processes
      console.log('✓ Filled labor description:', laborItem.name);
      
      const hoursField = inputs.find(inp => 
        inp.type === 'number' && (
          inp.placeholder?.toLowerCase().includes('hour') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('hour')
        )
      );
      if (hoursField) {
        hoursField.focus();
        setNativeInputValue(hoursField, laborItem.hours.toString());
        console.log('✓ Filled hours:', laborItem.hours);
      }
      
      const rateField = inputs.find(inp => 
        inp.type === 'number' && (
          inp.placeholder?.toLowerCase().includes('rate') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('rate')
        )
      );
      if (rateField) {
        rateField.focus();
        setNativeInputValue(rateField, laborItem.rate.toString());
        console.log('✓ Filled rate:', laborItem.rate);
      }
      
      // No Save button needed - labor stays in modal
      console.log('✓ Labor item filled (no save needed)');
      await new Promise(resolve => setTimeout(resolve, 800)); // Longer wait before moving to parts
    }

    // Now add parts - each part needs "Add Parts" → "Add part manually" flow
    for (const [partIndex, part] of jobData.parts.entries()) {
      console.log(`\n🔧 Adding part ${partIndex + 1}/${jobData.parts.length}: ${part.name}`);
      
      // Find "Add Parts" button in modal
      const addPartsButton = Array.from(document.querySelectorAll('button')).find(btn => {
        const text = btn.textContent.trim().toLowerCase();
        return text.includes('add part') || text === 'parts';
      });
      
      if (!addPartsButton) {
        console.error('❌ "Add Parts" button not found in modal');
        console.log('Available buttons:', Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()));
        isFillingJob = false;
        throw new Error('Could not find "Add Parts" button');
      }
      
      console.log('✓ Clicking "Add Parts" button');
      addPartsButton.click();
      
      // Wait for dropdown to appear and find "Add part manually" option
      console.log('⏳ Waiting for "Add part manually" option to appear...');
      let addManuallyOption = null;
      let attempts = 0;
      const maxAttempts = 20; // 20 attempts x 250ms = 5 seconds max
      
      while (!addManuallyOption && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 250));
        
        // Try to find the most specific clickable element
        const allElements = Array.from(document.querySelectorAll('button, a, li, div[role="option"], div[role="menuitem"], span'));
        const candidates = allElements.filter(el => {
          const text = el.textContent?.toLowerCase() || '';
          return text.includes('add part manually') || (text.includes('manually') && text.length < 50);
        });
        
        // Prefer buttons/links over divs/spans
        addManuallyOption = candidates.find(el => el.tagName === 'BUTTON' || el.tagName === 'A') || 
                           candidates.find(el => el.getAttribute('role') === 'option' || el.getAttribute('role') === 'menuitem') ||
                           candidates[0];
        
        attempts++;
        if (!addManuallyOption && attempts % 4 === 0) {
          console.log(`⏳ Still waiting for dropdown... (${attempts * 250}ms elapsed)`);
        }
      }
      
      if (!addManuallyOption) {
        console.log('⚠️ "Add part manually" not found after 5 seconds');
        isFillingJob = false;
        throw new Error('Could not find "Add part manually" option in dropdown');
      }
      
      // Snapshot BEFORE clicking "Add part manually"
      const elementsBefore = new Set(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
      console.log(`📊 Snapshot before Add part manually: ${elementsBefore.size} total form elements`);
      
      // Helper function to click element with multiple strategies
      function clickElement(element, description) {
        console.log(`🖱️ Clicking ${description}:`, {
          tag: element.tagName,
          className: element.className,
          text: element.textContent?.substring(0, 50),
          role: element.getAttribute('role')
        });
        
        // Strategy 1: Regular click
        element.click();
        
        // Strategy 2: Dispatch mouse events (more realistic)
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        
        console.log(`✓ Dispatched click events on ${description}`);
      }
      
      // Try clicking "Add part manually" with retry logic
      let newInputs = [];
      const maxClickRetries = 3;
      
      for (let clickAttempt = 1; clickAttempt <= maxClickRetries; clickAttempt++) {
        console.log(`\n🔄 Attempt ${clickAttempt}: Finding and clicking "Add part manually"...`);
        clickElement(addManuallyOption, '"Add part manually" option');
        
        // Wait progressively longer and check for new inputs
        console.log('⏳ Waiting for part form to render...');
        let waitAttempts = 0;
        const maxWaitAttempts = 10; // 10 attempts x 400ms = 4 seconds max per attempt
        
        while (newInputs.length === 0 && waitAttempts < maxWaitAttempts) {
          await new Promise(resolve => setTimeout(resolve, 400));
          const elementsAfter = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
          const newElements = elementsAfter.filter(el => !elementsBefore.has(el));
          
          // Filter to only visible, non-hidden inputs
          newInputs = newElements.filter(el => {
            if (el.type === 'hidden') return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });
          
          waitAttempts++;
          if (waitAttempts % 3 === 0) {
            console.log(`⏳ Still waiting for part inputs... (${waitAttempts * 400}ms elapsed, ${newInputs.length} visible inputs so far)`);
          }
        }
        
        if (newInputs.length > 0) {
          console.log(`✓ Detected ${newInputs.length} new visible input fields after ${waitAttempts * 400}ms on attempt ${clickAttempt}`);
          break; // Success! Exit retry loop
        }
        
        // No inputs found, try again if we have retries left
        if (clickAttempt < maxClickRetries) {
          console.log(`⚠️ No inputs appeared after ${waitAttempts * 400}ms. Retrying click...`);
          // Re-find the "Add part manually" option in case dropdown closed
          await new Promise(resolve => setTimeout(resolve, 500));
          
          const allElements = Array.from(document.querySelectorAll('button, a, li, div[role="option"], div[role="menuitem"], span'));
          const candidates = allElements.filter(el => {
            const text = el.textContent?.toLowerCase() || '';
            return text.includes('add part manually') || (text.includes('manually') && text.length < 50);
          });
          addManuallyOption = candidates.find(el => el.tagName === 'BUTTON' || el.tagName === 'A') || 
                             candidates.find(el => el.getAttribute('role') === 'option' || el.getAttribute('role') === 'menuitem') ||
                             candidates[0];
          
          if (!addManuallyOption) {
            console.log('⚠️ "Add part manually" option disappeared, clicking "Add Parts" again...');
            clickElement(addPartsButton, '"Add Parts" button (retry)');
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const allElements2 = Array.from(document.querySelectorAll('button, a, li, div[role="option"], div[role="menuitem"], span'));
            const candidates2 = allElements2.filter(el => {
              const text = el.textContent?.toLowerCase() || '';
              return text.includes('add part manually') || (text.includes('manually') && text.length < 50);
            });
            addManuallyOption = candidates2.find(el => el.tagName === 'BUTTON' || el.tagName === 'A') || 
                               candidates2.find(el => el.getAttribute('role') === 'option' || el.getAttribute('role') === 'menuitem') ||
                               candidates2[0];
            
            if (!addManuallyOption) {
              console.error('❌ Could not re-find "Add part manually" option');
              break;
            }
          }
        }
      }
      
      if (newInputs.length === 0) {
        console.error(`❌ No new visible inputs detected after ${maxClickRetries} attempts`);
        isFillingJob = false;
        throw new Error(`Add part manually did not create new input fields after ${maxClickRetries} attempts - UI may have changed`);
      }

      const inputs = newInputs;
      
      console.log(`\n📝 Filling part: ${part.name}`);
      console.log('Available new input fields:', inputs.map(inp => ({
        tag: inp.tagName,
        type: inp.type,
        placeholder: inp.placeholder,
        name: inp.name,
        id: inp.id
      })));
      
      // Tekmetric field order: Brand → Part Name → Part Number → Details → Quantity → Cost
      // Note: TAB simulation doesn't work - we must focus each field manually
      
      // Separate text inputs from number inputs
      const textInputs = inputs.filter(inp => inp.type === 'text' && inp.offsetParent !== null);
      const numberInputs = inputs.filter(inp => inp.type === 'number' && inp.offsetParent !== null);
      
      console.log('Found text inputs:', textInputs.length, 'number inputs:', numberInputs.length);
      console.log('Text input details:', textInputs.map(inp => ({placeholder: inp.placeholder, type: inp.type})));
      console.log('Number input details:', numberInputs.map(inp => ({placeholder: inp.placeholder, type: inp.type})));
      
      // Helper to fill text field using React-compatible setNativeInputValue
      async function fillTextField(element, text, label) {
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 50));
        setNativeInputValue(element, text);
        console.log(`✓ Filled ${label}:`, text);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      
      // Helper to fill number field using React-compatible setNativeInputValue
      async function fillNumberField(element, value, label) {
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 50));
        setNativeInputValue(element, value.toString());
        console.log(`✓ Filled ${label}:`, value);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      
      // Fill text fields in order: Brand (0), Part Name (1), Part Number (2), Details (3)
      console.log('Starting text field fills...');
      try {
        if (textInputs.length >= 4) {
          // Field 1: Brand
          if (part.brand) {
            console.log('About to fill brand:', part.brand);
            await fillTextField(textInputs[0], part.brand, 'brand');
          }
          
          // Field 2: Part Name (description)
          console.log('About to fill part name:', part.name);
          await fillTextField(textInputs[1], part.name, 'part name');
          
          // Field 3: Part Number
          if (part.partNumber) {
            console.log('About to fill part number:', part.partNumber);
            await fillTextField(textInputs[2], part.partNumber, 'part number');
          }
          
          // Field 4: Additional Details - skip (textInputs[3])
        } else {
          console.error('❌ Expected at least 4 text inputs, found:', textInputs.length);
        }
      } catch (error) {
        console.error('❌ Error filling text fields:', error);
      }
      
      // Fill number fields in order: Quantity (0), Cost (1)
      console.log('Starting number field fills...');
      try {
        if (numberInputs.length >= 2) {
          // Field 5: Quantity
          console.log('About to fill quantity:', part.quantity);
          await fillNumberField(numberInputs[0], part.quantity, 'quantity');
          
          // Field 6: Cost
          if (part.cost) {
            console.log('About to fill cost:', part.cost);
            await fillNumberField(numberInputs[1], part.cost, 'cost');
          }
        } else {
          console.error('❌ Expected at least 2 number inputs, found:', numberInputs.length);
        }
      } catch (error) {
        console.error('❌ Error filling number fields:', error);
      }
      
      // Fill sale/retail price field
      const retailField = inputs.find(inp => 
        inp.type === 'number' && (
          inp.placeholder?.toLowerCase().includes('retail') ||
          inp.placeholder?.toLowerCase().includes('sale') ||
          inp.placeholder?.toLowerCase().includes('price') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('sale') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('retail')
        )
      );
      if (retailField && part.retail) {
        retailField.focus();
        setNativeInputValue(retailField, part.retail.toString());
        console.log('✓ Filled sale price:', part.retail);
      }
      
      // Don't click save yet - wait until all parts are filled!
      console.log(`✓ Part ${partIndex + 1}/${jobData.parts.length} filled successfully`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Find and click the final SAVE button (multiple attempts with better detection)
    console.log('\n💾 Looking for final SAVE button in modal...');
    let finalSaveButton = null;
    let saveAttempts = 0;
    const maxSaveAttempts = 5;
    
    while (!finalSaveButton && saveAttempts < maxSaveAttempts) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // CRITICAL: Search only within modal to avoid clicking BUILD button at bottom of page
      const buttons = Array.from(modal.querySelectorAll('button'));
      finalSaveButton = buttons.find(btn => {
        const text = btn.textContent?.trim().toUpperCase() || '';
        const isVisible = btn.offsetParent !== null; // Check if visible
        return isVisible && (
          text === 'SAVE' || 
          text.includes('SAVE') ||
          (btn.getAttribute('type') === 'submit' && text.length < 15)
        );
      });
      
      saveAttempts++;
      if (!finalSaveButton && saveAttempts % 2 === 0) {
        console.log(`⏳ Still looking for SAVE button in modal... (attempt ${saveAttempts})`);
      }
    }
    
    if (finalSaveButton) {
      console.log('✓ Found SAVE button, clicking now...');
      clickElement(finalSaveButton, 'final SAVE button');
      await new Promise(resolve => setTimeout(resolve, 1500));
      console.log("✅ Successfully filled and saved Tekmetric job!");
    } else {
      console.log('⚠️ Could not find SAVE button - user may need to click it manually');
      console.log("✅ Successfully filled Tekmetric job (manual save required)!");
    }
    
    chrome.runtime.sendMessage({ action: "CLEAR_PENDING_JOB" }, (response) => {
      console.log("📦 Cleared pending job after success:", response);
    });
    
    showSuccessNotification(jobData);
    isFillingJob = false;
    
  } catch (error) {
    console.error("❌ Error filling Tekmetric estimate:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    // CRITICAL: Clear job data even on error to prevent infinite loop
    chrome.runtime.sendMessage({ action: "CLEAR_PENDING_JOB" }, (response) => {
      console.log("📦 Cleared pending job after error:", response);
    });
    
    showErrorNotification(error.message);
    isFillingJob = false;
    throw error; // Re-throw to ensure it appears in console
  }
}

function showSuccessNotification(jobData) {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #10b981;
    color: white;
    padding: 16px 24px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    max-width: 400px;
  `;
  
  const title = document.createElement('div');
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '4px';
  title.textContent = '✓ Job Imported Successfully';
  
  const details = document.createElement('div');
  details.textContent = `${jobData.jobName} - ${jobData.laborItems.length} labor items, ${jobData.parts.length} parts`;
  
  notification.appendChild(title);
  notification.appendChild(details);
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.transition = 'opacity 0.3s';
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, 5000);
}

// Show a friendly hint to click the extension icon for side panel
function showSidePanelHint() {
  // Remove existing hint if any
  const existing = document.getElementById('heart-side-panel-hint');
  if (existing) existing.remove();
  
  const hint = document.createElement('div');
  hint.id = 'heart-side-panel-hint';
  hint.innerHTML = `
    <style>
      #heart-side-panel-hint {
        position: fixed;
        top: 60px;
        right: 20px;
        background: linear-gradient(135deg, #c41230 0%, #a30f28 100%);
        color: white;
        padding: 16px 20px;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(196, 18, 48, 0.3);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 14px;
        max-width: 280px;
        animation: slideIn 0.3s ease-out;
      }
      #heart-side-panel-hint .hint-title {
        font-weight: 600;
        font-size: 15px;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #heart-side-panel-hint .hint-text {
        opacity: 0.95;
        line-height: 1.4;
      }
      #heart-side-panel-hint .hint-arrow {
        position: absolute;
        top: -8px;
        right: 30px;
        width: 0;
        height: 0;
        border-left: 8px solid transparent;
        border-right: 8px solid transparent;
        border-bottom: 8px solid #c41230;
      }
      @keyframes slideIn {
        from { transform: translateY(-10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    </style>
    <div class="hint-arrow"></div>
    <div class="hint-title">♥ Open HEART Helper</div>
    <div class="hint-text">Click the <strong>HEART Helper icon</strong> in your browser toolbar (top-right) to open the side panel.</div>
  `;
  document.body.appendChild(hint);
  
  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    hint.style.animation = 'slideIn 0.3s ease-out reverse';
    setTimeout(() => hint.remove(), 300);
  }, 5000);
  
  // Click to dismiss
  hint.addEventListener('click', () => {
    hint.style.animation = 'slideIn 0.3s ease-out reverse';
    setTimeout(() => hint.remove(), 300);
  });
}

function showErrorNotification(message) {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #ef4444;
    color: white;
    padding: 16px 24px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    max-width: 400px;
  `;
  
  const title = document.createElement('div');
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '4px';
  title.textContent = '⚠ Import Failed';
  
  const details = document.createElement('div');
  details.textContent = message;
  
  notification.appendChild(title);
  notification.appendChild(details);
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.transition = 'opacity 0.3s';
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, 7000);
}

function checkForPendingJob() {
  console.log("🔍 Checking for pending job data...");
  chrome.runtime.sendMessage({ action: "GET_PENDING_JOB" }, (response) => {
    console.log("📬 GET_PENDING_JOB response:", response);
    if (response && response.jobData) {
      console.log("✅ Found pending job data, auto-filling...");
      console.log("Job data:", response.jobData);
      fillTekmetricEstimate(response.jobData);
    } else {
      console.log("⚠️ No pending job data found");
    }
  });
}

// Listen for storage changes to trigger automation instantly
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.lastJobData) {
    console.log("🔔 Storage changed - job data added!");
    if (changes.lastJobData.newValue) {
      console.log("⚡ Triggering automation immediately!");
      fillTekmetricEstimate(changes.lastJobData.newValue);
    }
  }
});

// Listen for messages from the search tool (cross-tab communication)
window.addEventListener('message', (event) => {
  console.log("📬 Received window message:", event.data);
  
  // Verify origin for security
  if (event.origin !== window.location.origin) {
    console.log("⚠️ Ignoring message from different origin:", event.origin);
    return;
  }
  
  // Check if it's a job data message
  if (event.data && event.data.action === 'SEND_TO_TEKMETRIC' && event.data.payload) {
    console.log("✅ Received job data from search tool!");
    console.log("Job data:", event.data.payload);
    
    // Store the job data for cross-tab access
    chrome.runtime.sendMessage({
      action: "STORE_PENDING_JOB",
      jobData: event.data.payload
    }, (response) => {
      console.log("📦 Job data stored in extension storage:", response);
    });
  }
});

console.log("📋 Tekmetric Job Importer initialized, document ready state:", document.readyState);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log("📄 DOMContentLoaded - checking for pending jobs in 2s...");
    setTimeout(checkForPendingJob, 2000);
  });
} else {
  console.log("📄 Document already loaded - checking for pending jobs in 2s...");
  setTimeout(checkForPendingJob, 2000);
}

const observer = new MutationObserver(() => {
  if (window.location.href.includes('/estimates/') || window.location.href.includes('/repair-orders/')) {
    checkForPendingJob();
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

function extractVehicleData() {
  const data = {
    make: '',
    model: '',
    year: '',
    engine: '',
    concerns: '',
    repairOrderId: ''
  };

  const allText = document.body.innerText;
  
  const urlMatch = window.location.href.match(/repair-orders\/(\d+)/);
  if (urlMatch) {
    data.repairOrderId = urlMatch[1];
    console.log("Extracted RO ID from URL:", data.repairOrderId);
  }
  
  const vinMatch = allText.match(/VIN[:\s]*([A-HJ-NPR-Z0-9]{17})/i);
  if (vinMatch) {
    data.vin = vinMatch[1];
  }

  const yearMatch = allText.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    data.year = yearMatch[0];
  }

  const makeModelRegex = /(Toyota|Honda|Ford|Chevrolet|Nissan|Hyundai|Kia|Jeep|Ram|GMC|Subaru|Mazda|Volkswagen|BMW|Mercedes-Benz|Audi|Lexus|Acura|Infiniti|Cadillac|Buick|Lincoln|Chrysler|Dodge|Mitsubishi|Volvo|Porsche|Tesla|Land Rover|Jaguar|Mini|Fiat|Alfa Romeo)\s+([A-Za-z0-9\s-]+?)(?=\s+\d{4}|\s+Sport|\s+\d\.\d)/i;
  const makeModelMatch = allText.match(makeModelRegex);
  if (makeModelMatch) {
    data.make = makeModelMatch[1];
    data.model = makeModelMatch[2].trim();
  }

  const engineMatch = allText.match(/(\d\.\d+L)\s*(V\d+|I\d+|H\d+)?/i);
  if (engineMatch) {
    data.engine = engineMatch[0].trim();
  }

  const concernsElements = document.querySelectorAll('[class*="concern" i], [class*="customer" i] textarea, [class*="complaint" i] textarea, [class*="issue" i] textarea');
  if (concernsElements.length > 0) {
    data.concerns = Array.from(concernsElements)
      .map(el => el.value || el.textContent)
      .filter(text => text && text.trim().length > 5)
      .join(', ')
      .trim()
      .substring(0, 200);
  }

  if (!data.concerns) {
    const labels = Array.from(document.querySelectorAll('label, div'));
    for (const label of labels) {
      const labelText = label.textContent.toLowerCase();
      if (labelText.includes('concern') || labelText.includes('complaint') || labelText.includes('customer') || labelText.includes('reason for visit')) {
        const nextElement = label.nextElementSibling;
        if (nextElement && (nextElement.tagName === 'TEXTAREA' || nextElement.tagName === 'INPUT')) {
          const text = nextElement.value || nextElement.textContent;
          if (text && text.trim().length > 5) {
            data.concerns = text.trim().substring(0, 200);
            break;
          }
        }
        
        const textarea = label.querySelector('textarea') || label.querySelector('input[type="text"]');
        if (textarea) {
          const text = textarea.value || textarea.textContent;
          if (text && text.trim().length > 5) {
            data.concerns = text.trim().substring(0, 200);
            break;
          }
        }
      }
    }
  }

  if (!data.concerns) {
    const textAreas = document.querySelectorAll('textarea');
    for (const textarea of textAreas) {
      const text = textarea.value || textarea.textContent;
      if (text && text.trim().length > 10 && text.trim().length < 500) {
        const trimmedText = text.trim();
        if (!trimmedText.toLowerCase().includes('internal note') && 
            !trimmedText.toLowerCase().includes('technician note')) {
          data.concerns = trimmedText.substring(0, 200);
          break;
        }
      }
    }
  }

  console.log("Extracted vehicle data:", data);
  return data;
}

// No need for SVG - we'll use ❤️ emoji!

// Inject HEART icon next to 3-dot menu for a concern line item
function injectHeartIconForConcern(concernRow, concernText) {
  // Check if already injected for this element
  if (injectedIcons.has(concernRow)) {
    return;
  }
  
  // Create the icon button with ♥ in HEART Red
  const iconButton = document.createElement('button');
  iconButton.className = 'heart-helper-icon';
  iconButton.innerHTML = '♥'; // Use HTML heart entity that can be colored with CSS
  iconButton.style.cssText = `
    background: transparent;
    border: none;
    font-size: 20px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    margin-left: 4px;
    margin-right: 4px;
    padding: 0;
    vertical-align: middle;
    opacity: 0.8;
    color: #ED1C24;
    font-weight: bold;
  `;
  
  // Hover effects
  iconButton.addEventListener('mouseenter', () => {
    iconButton.style.transform = 'scale(1.2)';
    iconButton.style.opacity = '1';
  });
  
  iconButton.addEventListener('mouseleave', () => {
    iconButton.style.transform = 'scale(1)';
    iconButton.style.opacity = '0.7';
  });
  
  // Click handler - open search with this specific concern
  iconButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!concernText || !concernText.trim()) {
      showErrorNotification('No concern text found.');
      return;
    }
    
    const vehicleData = extractVehicleData();
    
    const params = new URLSearchParams();
    if (vehicleData.make) params.set('make', vehicleData.make);
    if (vehicleData.model) params.set('model', vehicleData.model);
    if (vehicleData.year) params.set('year', vehicleData.year);
    if (vehicleData.engine) params.set('engine', vehicleData.engine);
    params.set('search', concernText.trim().substring(0, 200)); // Use THIS concern text
    if (vehicleData.repairOrderId) params.set('roId', vehicleData.repairOrderId);
    
    chrome.storage.local.get(['appUrl'], (result) => {
      if (!result.appUrl) {
        showErrorNotification('Extension not configured. Click the extension icon and set your app URL in Settings.');
        return;
      }
      
      const searchUrl = `${result.appUrl}/?${params.toString()}`;
      
      console.log("Opening HEART Helper with concern:", concernText.substring(0, 50));
      console.log("Search URL:", searchUrl);
      window.open(searchUrl, '_blank');
    });
  });
  
  // Find the 3-dot menu button in this row and insert HEART icon before it
  const threeDotsButton = concernRow.querySelector('button[aria-label*="menu" i], button[aria-label*="more" i], button[aria-label*="options" i]') ||
                          Array.from(concernRow.querySelectorAll('button')).find(btn => {
                            const svg = btn.querySelector('svg');
                            return svg && btn.children.length === 1; // Likely icon-only button
                          });
  
  if (threeDotsButton) {
    threeDotsButton.parentElement.insertBefore(iconButton, threeDotsButton);
    console.log("✓ HEART icon injected next to 3-dot menu");
  } else {
    // Fallback: append to end of row
    concernRow.appendChild(iconButton);
    console.log("✓ HEART icon injected at end of concern row");
  }
  
  injectedIcons.add(concernRow);
}


// Create a heart button with click handler
function createHeartButton(searchText) {
  const heartBtn = document.createElement('span');
  heartBtn.className = 'heart-helper-inline';
  heartBtn.innerHTML = '♥';
  heartBtn.title = 'Search HEART Helper for: ' + searchText.substring(0, 50);
  heartBtn.style.cssText = `
    color: #ED1C24;
    font-size: 18px;
    cursor: pointer;
    margin-right: 8px;
    opacity: 0.85;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  `;
  
  heartBtn.addEventListener('mouseenter', () => {
    heartBtn.style.transform = 'scale(1.2)';
    heartBtn.style.opacity = '1';
  });
  
  heartBtn.addEventListener('mouseleave', () => {
    heartBtn.style.transform = 'scale(1)';
    heartBtn.style.opacity = '0.85';
  });
  
  heartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const vehicleData = extractVehicleData();
    const params = new URLSearchParams();
    if (vehicleData.make) params.set('make', vehicleData.make);
    if (vehicleData.model) params.set('model', vehicleData.model);
    if (vehicleData.year) params.set('year', vehicleData.year);
    if (vehicleData.engine) params.set('engine', vehicleData.engine);
    params.set('search', searchText.substring(0, 200));
    if (vehicleData.repairOrderId) params.set('roId', vehicleData.repairOrderId);
    
    chrome.storage.local.get(['appUrl'], (result) => {
      if (!result.appUrl) {
        showErrorNotification('Extension not configured.');
        return;
      }
      const searchUrl = `${result.appUrl}/?${params.toString()}`;
      console.log("Opening HEART Helper:", searchText.substring(0, 50));
      window.open(searchUrl, '_blank');
    });
  });
  
  return heartBtn;
}

// Find and inject icons for concern items - SIMPLE APPROACH
// Just find 3-dot menu buttons and put hearts to their left
function injectHeartIcons() {
  if (!window.location.href.includes('/repair-orders/')) {
    return;
  }
  // Side panel is the primary interface - use extension icon or keyboard shortcut to open
}

function observePageChanges() {
  const checkAndInject = () => {
    if (window.location.href.includes('/repair-orders/')) {
      // Try immediately
      injectHeartIcons();
      // Re-check after delays (fields load asynchronously in Tekmetric)
      setTimeout(injectHeartIcons, 1000);
      setTimeout(injectHeartIcons, 2000);
      setTimeout(injectHeartIcons, 3000);
      setTimeout(injectHeartIcons, 5000);
    } else {
      // Clear tracked icons when leaving repair order page
      injectedIcons.clear();
    }
  };

  checkAndInject();

  const urlObserver = new MutationObserver(checkAndInject);
  urlObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  let lastUrl = window.location.href;
  setInterval(() => {
    if (lastUrl !== window.location.href) {
      console.log(`🔄 URL changed: ${lastUrl} → ${window.location.href}`);
      // Clear tracked icons when navigating between pages
      injectedIcons.clear();
      lastUrl = window.location.href;
      checkAndInject();
    }
  }, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observePageChanges);
} else {
  observePageChanges();
}

// ==========================================
// Side Panel Message Handlers
// ==========================================

// Only register message handlers in the main frame (not iframes)
if (window.self === window.top) {
  console.warn('[Content] Main frame detected - registering side panel message handler...');

  // Listen for messages from side panel
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Use alert-style logging that can't be filtered
    console.warn('[Content v3.14.8] MESSAGE RECEIVED:', message.type);
  
  // Get current vehicle info for side panel
  if (message.type === 'GET_VEHICLE_INFO') {
    console.warn('[Content] GET_VEHICLE_INFO handler started');
    
    // Test URL extraction immediately
    const testIds = extractIdsFromUrl();
    console.warn('[Content] URL extraction result:', JSON.stringify(testIds));
    
    // First try to fetch from API for accurate data
    fetchVehicleInfoFromAPI().then(apiData => {
      console.warn('[Content] API response:', JSON.stringify(apiData ? { hasVehicle: !!apiData.vehicle } : null));
      if (apiData && apiData.vehicle) {
        const vehicleData = {
          year: apiData.vehicle.year,
          make: apiData.vehicle.make,
          model: apiData.vehicle.model,
          engine: apiData.vehicle.engine || null
        };
        console.warn('[Content] Sending API vehicle:', JSON.stringify(vehicleData));
        sendResponse({ vehicleInfo: vehicleData });
      } else {
        // Fallback to DOM scraping
        console.warn('[Content] API failed/empty, using DOM scraping');
        const vehicleInfo = extractVehicleInfo();
        console.warn('[Content] DOM scraped:', JSON.stringify(vehicleInfo));
        sendResponse({ vehicleInfo });
      }
    }).catch(error => {
      console.error('[Content] API error:', error.message);
      const vehicleInfo = extractVehicleInfo();
      sendResponse({ vehicleInfo });
    });
    return true; // Keep channel open for async response
  }
  
  // Get full RO info for sales script generation
  if (message.type === 'GET_RO_INFO') {
    // First try to fetch from API for accurate data
    fetchVehicleInfoFromAPI().then(apiData => {
      if (apiData) {
        console.log('Sending API RO data:', apiData);
        sendResponse({ 
          roInfo: {
            roId: apiData.id,
            roNumber: apiData.roNumber,
            customer: apiData.customer ? {
              name: `${apiData.customer.firstName} ${apiData.customer.lastName}`.trim()
            } : null,
            vehicle: apiData.vehicle,
            jobs: apiData.jobs || []
          }
        });
      } else {
        // Fallback to DOM scraping
        console.log('API failed, using DOM scraping for RO info');
        const roInfo = extractROInfo();
        sendResponse({ roInfo });
      }
    }).catch(error => {
      console.error('API fetch error:', error);
      const roInfo = extractROInfo();
      sendResponse({ roInfo });
    });
    return true; // Keep channel open for async response
  }
  
  // Paste cleaned concern text into Tekmetric
  if (message.type === 'PASTE_CONCERN') {
    console.log('📝 PASTE_CONCERN received, text length:', message.text?.length);
    const concernField = findConcernField();
    if (concernField) {
      console.log('✅ Found concern field:', concernField.id || concernField.name || 'unnamed');
      
      // Focus the field first
      concernField.focus();
      
      // Use setNativeInputValue for React compatibility
      if (concernField.tagName === 'TEXTAREA' || concernField.tagName === 'INPUT') {
        setNativeInputValue(concernField, message.text);
        console.log('✅ Text inserted via setNativeInputValue');
      } else {
        concernField.textContent = message.text;
        concernField.dispatchEvent(new Event('input', { bubbles: true }));
        console.log('✅ Text set via textContent');
      }
      
      sendResponse({ success: true });
    } else {
      console.log('❌ Could not find concern field on this page');
      sendResponse({ success: false, error: 'Concern field not found. Make sure you have a customer concern dialog open.' });
    }
    return true;
  }
  
  // Add cleaned concern text to the repair order
  if (message.type === 'ADD_CONCERN_TO_RO') {
    console.log('📝 ADD_CONCERN_TO_RO received');
    const concernText = message.concernText;
    
    // Find concern/complaint textarea on the page
    const concernField = findConcernField();
    
    if (concernField) {
      // Append to existing content if any
      const existingValue = concernField.value || concernField.textContent || '';
      const newValue = existingValue 
        ? `${existingValue}\n\n${concernText}` 
        : concernText;
      
      // Focus the field first
      concernField.focus();
      
      if (concernField.tagName === 'TEXTAREA' || concernField.tagName === 'INPUT') {
        setNativeInputValue(concernField, newValue);
      } else {
        concernField.textContent = newValue;
        concernField.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      console.log("✅ Added concern text to RO:", concernText.substring(0, 50) + '...');
      sendResponse({ success: true });
    } else {
      console.log("❌ Could not find concern field on page");
      sendResponse({ success: false, error: 'Concern field not found. Make sure you have a customer concern dialog open.' });
    }
    return true;
  }
  
  // Handle job creation from search results
  if (message.type === 'CREATE_JOB_FROM_SEARCH') {
    console.log('Received job data from search:', message.jobData);
    
    // Store the pending job data for when user clicks "Add Service"
    pendingJobDataFromSearch = message.jobData;
    
    // Show visual indicator that job is ready
    showJobReadyIndicator();
    
    sendResponse({ success: true });
    return true;
  }
});
} // End of if (window.self === window.top) block

// Store pending job data from search
let pendingJobDataFromSearch = null;

// Show indicator that job data is ready
function showJobReadyIndicator() {
  // Remove any existing indicator
  const existing = document.getElementById('heart-job-ready-indicator');
  if (existing) existing.remove();
  
  const indicator = document.createElement('div');
  indicator.id = 'heart-job-ready-indicator';
  indicator.innerHTML = `
    <style>
      #heart-job-ready-indicator {
        position: fixed;
        top: 10px;
        right: 10px;
        background: #c41230;
        color: white;
        padding: 12px 16px;
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 13px;
        font-weight: 500;
        z-index: 999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        animation: slideIn 0.3s ease-out;
      }
      #heart-job-ready-indicator .title {
        font-weight: 600;
        margin-bottom: 4px;
      }
      #heart-job-ready-indicator .subtitle {
        opacity: 0.9;
        font-size: 12px;
      }
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    </style>
    <div class="title">Job Ready to Import</div>
    <div class="subtitle">${pendingJobDataFromSearch?.name || 'Job data loaded'}</div>
  `;
  document.body.appendChild(indicator);
  
  // Auto-remove after 5 seconds
  setTimeout(() => {
    indicator.style.animation = 'slideIn 0.3s ease-out reverse';
    setTimeout(() => indicator.remove(), 300);
  }, 5000);
}

// Extract vehicle info from Tekmetric page
// Extract shop ID and RO ID from Tekmetric URL
function extractIdsFromUrl() {
  // URL patterns:
  // https://shop.tekmetric.com/admin/shop/{shopId}/repair-orders/{roId}/estimate
  // https://shop.tekmetric.com/shop/{shopId}/repair-orders/{roId}
  const url = window.location.href;
  // Match both /admin/shop/ and /shop/ patterns
  const match = url.match(/\/(?:admin\/)?shop\/(\d+)\/repair-orders\/(\d+)/);
  if (match) {
    console.log('[Content] Extracted IDs from URL:', { shopId: match[1], roId: match[2] });
    return { shopId: match[1], roId: match[2] };
  }
  console.log('[Content] Could not extract IDs from URL:', url);
  return null;
}

// Cache for API-fetched RO data to avoid repeated calls
let cachedROData = null;
let cachedROUrl = null;

// Fetch vehicle info from our API (uses Tekmetric API for accurate data)
async function fetchVehicleInfoFromAPI() {
  const ids = extractIdsFromUrl();
  if (!ids) {
    console.log('Not on a Tekmetric RO page, cannot fetch from API');
    return null;
  }
  
  // Check cache first
  if (cachedROData && cachedROUrl === window.location.href) {
    console.log('Using cached RO data');
    return cachedROData;
  }
  
  try {
    // Get app URL from storage
    const result = await new Promise(resolve => {
      chrome.storage.local.get(['appUrl'], resolve);
    });
    const syncResult = await new Promise(resolve => {
      chrome.storage.sync.get(['heartHelperUrl'], resolve);
    });
    
    const appUrl = syncResult.heartHelperUrl || result.appUrl;
    if (!appUrl) {
      console.log('App URL not configured, cannot fetch from API');
      return null;
    }
    
    console.log(`Fetching RO data from API: ${appUrl}/api/tekmetric/ro/${ids.shopId}/${ids.roId}`);
    
    const response = await fetch(`${appUrl}/api/tekmetric/ro/${ids.shopId}/${ids.roId}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      console.log(`API returned ${response.status}, falling back to DOM scraping`);
      return null;
    }
    
    const data = await response.json();
    console.log('Got RO data from API:', data);
    
    // Cache the result
    cachedROData = data;
    cachedROUrl = window.location.href;
    
    return data;
  } catch (error) {
    console.error('Error fetching from API:', error);
    return null;
  }
}

function extractVehicleInfo() {
  let vehicleInfo = { year: null, make: null, model: null, engine: null };
  
  // Check if we have cached API data
  if (cachedROData && cachedROData.vehicle && cachedROUrl === window.location.href) {
    console.log('Using cached API vehicle data');
    return {
      year: cachedROData.vehicle.year,
      make: cachedROData.vehicle.make,
      model: cachedROData.vehicle.model,
      engine: cachedROData.vehicle.engine || null
    };
  }
  
  try {
    // Fallback to DOM scraping if API data not available
    // Strategy 1: Look for vehicle header text
    const headerElements = document.querySelectorAll('h1, h2, h3, h4, .vehicle-info, [class*="vehicle"], [class*="Vehicle"]');
    for (const el of headerElements) {
      const text = el.textContent?.trim() || '';
      // Look for pattern like "2018 Toyota Sienna"
      const match = text.match(/(\d{4})\s+([A-Za-z]+)\s+([A-Za-z0-9\s-]+)/);
      if (match) {
        vehicleInfo = {
          year: parseInt(match[1]),
          make: match[2],
          model: match[3].trim(),
          engine: null
        };
        break;
      }
    }
    
    // Strategy 2: Look for data attributes
    if (!vehicleInfo.year) {
      const vehicleEl = document.querySelector('[data-vehicle-year], [data-year]');
      if (vehicleEl) {
        vehicleInfo.year = parseInt(vehicleEl.getAttribute('data-vehicle-year') || vehicleEl.getAttribute('data-year'));
      }
      const makeEl = document.querySelector('[data-vehicle-make], [data-make]');
      if (makeEl) {
        vehicleInfo.make = makeEl.getAttribute('data-vehicle-make') || makeEl.getAttribute('data-make');
      }
      const modelEl = document.querySelector('[data-vehicle-model], [data-model]');
      if (modelEl) {
        vehicleInfo.model = modelEl.getAttribute('data-vehicle-model') || modelEl.getAttribute('data-model');
      }
    }
    
    // Strategy 3: Look for labeled fields
    if (!vehicleInfo.year) {
      const labels = document.querySelectorAll('label, span, div');
      for (const label of labels) {
        const text = label.textContent?.toLowerCase() || '';
        const nextEl = label.nextElementSibling;
        if (text.includes('year') && nextEl) {
          const yearText = nextEl.textContent?.match(/\d{4}/)?.[0];
          if (yearText) vehicleInfo.year = parseInt(yearText);
        }
        if (text.includes('make') && nextEl) {
          vehicleInfo.make = nextEl.textContent?.trim();
        }
        if (text.includes('model') && nextEl) {
          vehicleInfo.model = nextEl.textContent?.trim();
        }
      }
    }
  } catch (error) {
    console.error('Error extracting vehicle info:', error);
  }
  
  return vehicleInfo;
}

// Find concern/complaint text field on the page
function findConcernField() {
  // Determine which page we're on by URL
  const url = window.location.href;
  const isRepairOrderPage = /\/repair-orders\//.test(url);
  const isAppointmentPage = /\/appointments\/create/.test(url);
  
  // Strategy 1: Look for specific Tekmetric IDs first
  let targetField = document.querySelector('textarea#concern');
  if (targetField) {
    console.log('Found concern field by #concern ID');
    return targetField;
  }
  
  targetField = document.querySelector('textarea#description');
  if (targetField) {
    console.log('Found concern field by #description ID');
    return targetField;
  }
  
  // Strategy 2: Look for data-cy attribute (Tekmetric's test selectors)
  targetField = document.querySelector('[data-cy="customer-concern"] textarea');
  if (targetField) {
    console.log('Found concern field by data-cy selector');
    return targetField;
  }
  
  targetField = document.querySelector('[data-cy="concern-textarea"]');
  if (targetField) {
    console.log('Found concern field by data-cy concern-textarea');
    return targetField;
  }
  
  // Strategy 3: Look for textareas with concern-related placeholders or labels
  const textareas = document.querySelectorAll('textarea');
  for (const textarea of textareas) {
    const placeholder = textarea.placeholder?.toLowerCase() || '';
    const label = textarea.getAttribute('aria-label')?.toLowerCase() || '';
    const id = textarea.id?.toLowerCase() || '';
    const name = textarea.name?.toLowerCase() || '';
    
    if (placeholder.includes('concern') || placeholder.includes('complaint') ||
        placeholder.includes('customer') || placeholder.includes('issue') ||
        label.includes('concern') || label.includes('complaint') ||
        id.includes('concern') || id.includes('complaint') ||
        name.includes('concern') || name.includes('complaint')) {
      console.log('Found concern field by attribute matching:', id || name || placeholder);
      return textarea;
    }
  }
  
  // Strategy 4: Look for form labels containing "concern" and get associated textarea
  const labels = document.querySelectorAll('label');
  for (const label of labels) {
    const labelText = label.textContent?.toLowerCase() || '';
    if (labelText.includes('concern') || labelText.includes('complaint') || labelText.includes('customer issue')) {
      // Look for textarea in the same container
      const container = label.closest('div, section, form');
      if (container) {
        const textarea = container.querySelector('textarea');
        if (textarea) {
          console.log('Found concern field by label association');
          return textarea;
        }
      }
      // Check for "for" attribute
      const forId = label.getAttribute('for');
      if (forId) {
        const textarea = document.getElementById(forId);
        if (textarea && textarea.tagName === 'TEXTAREA') {
          console.log('Found concern field by label for attribute');
          return textarea;
        }
      }
    }
  }
  
  // Strategy 5: Fallback - look for any visible textarea that might be a notes field
  for (const textarea of textareas) {
    const style = window.getComputedStyle(textarea);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      // Check parent for concern-related classes
      const parent = textarea.closest('[class*="concern"], [class*="complaint"], [class*="note"]');
      if (parent) {
        console.log('Found concern field by parent class');
        return textarea;
      }
    }
  }
  
  console.log('Could not find concern field on this page');
  return null;
}

// Extract full repair order info for sales script generation
function extractROInfo() {
  const roInfo = {
    vehicle: null,
    jobs: [],
    customer: null,
    totalAmount: null,
    isInShop: false // Determine context: in-shop vs follow-up call
  };
  
  try {
    // Get vehicle info
    roInfo.vehicle = extractVehicleInfo();
    
    // Extract customer name from RO header (e.g., "CAREY LEWIS's 2015 Subaru...")
    const roHeader = document.querySelector('h1, h2, [class*="ro-header"], [class*="RoHeader"]');
    if (roHeader) {
      const headerText = roHeader.textContent || '';
      // Match pattern like "CAREY LEWIS's" at the start
      const customerMatch = headerText.match(/^[A-Z\s]+(?='s\s)/);
      if (customerMatch) {
        roInfo.customer = { name: customerMatch[0].trim() };
      }
    }
    
    // Detect if vehicle is currently in shop based on RO column status
    // "Work in Progress" column = vehicle IS on premises (in-shop)
    // "Estimate" column = vehicle is NOT on premises (follow-up call)
    roInfo.isInShop = false;
    
    // Strategy 1: Look for status element with data-testid
    const statusElement = document.querySelector('[data-testid="repair-order-status"]');
    if (statusElement) {
      const statusText = (statusElement.textContent || '').toLowerCase().trim();
      console.log('Found RO status element:', statusText);
      // Work in Progress means vehicle is in-shop
      roInfo.isInShop = statusText.includes('work in progress') || 
                        statusText.includes('in progress') ||
                        statusText.includes('wip');
    }
    
    // Strategy 2: Look for column header or breadcrumb showing current workflow stage
    if (!statusElement) {
      const pageText = document.body.innerText || '';
      // Check for Work in Progress indicators (vehicle on premises)
      const wipIndicators = ['Work in Progress', 'In Progress', 'WIP'];
      const hasWIP = wipIndicators.some(indicator => pageText.includes(indicator));
      
      // Check for Estimate indicator (vehicle NOT on premises = follow-up call)
      const isEstimate = /\bEstimate\b/i.test(pageText) && !hasWIP;
      
      // If we find Work in Progress anywhere on the page, vehicle is likely in-shop
      roInfo.isInShop = hasWIP && !isEstimate;
      console.log('RO status detection - hasWIP:', hasWIP, 'isEstimate:', isEstimate, 'isInShop:', roInfo.isInShop);
    }
    
    // Extract total amount from the page
    // Look for common patterns: "Total: $XX.XX", "Grand Total $XX.XX", etc.
    const allElements = document.querySelectorAll('*');
    
    // Strategy 1: Look for labeled totals
    for (const el of allElements) {
      const text = el.textContent?.trim() || '';
      // Match patterns like "Total $64.80", "Grand Total: $1,234.56", "Total Amount $99.00"
      const totalMatch = text.match(/(?:grand\s+)?total(?:\s+amount)?[:\s]*\$?([\d,]+\.?\d*)/i);
      if (totalMatch) {
        const amount = parseFloat(totalMatch[1].replace(/,/g, ''));
        if (amount > 0 && amount < 100000) {
          // Prefer larger amounts (grand total vs subtotal)
          if (!roInfo.totalAmount || amount > roInfo.totalAmount) {
            roInfo.totalAmount = amount;
          }
        }
      }
    }
    
    // Strategy 2: Look for prominent price displays (often the largest visible dollar amount)
    if (!roInfo.totalAmount) {
      const priceElements = [];
      for (const el of allElements) {
        if (el.children.length > 3) continue; // Skip container elements
        const text = el.textContent?.trim() || '';
        const priceMatch = text.match(/^\$?([\d,]+\.\d{2})$/);
        if (priceMatch) {
          const amount = parseFloat(priceMatch[1].replace(/,/g, ''));
          if (amount > 10 && amount < 100000) {
            priceElements.push({ el, amount });
          }
        }
      }
      // Take the largest price as likely total
      if (priceElements.length > 0) {
        priceElements.sort((a, b) => b.amount - a.amount);
        roInfo.totalAmount = priceElements[0].amount;
      }
    }
    
    const seenJobs = new Set();
    
    // Strategy 1: Find the "Jobs" section and extract job names
    // Look for section headers containing "Jobs" or job accordions
    const allText = document.body.innerText;
    
    // Find all elements that could be job headers/titles
    // Tekmetric shows jobs like "TIRE SWAP WITH WHEELS - WINTER" with status/date below
    
    for (const el of allElements) {
      // Skip if too many children (not a leaf/title element)
      if (el.children.length > 5) continue;
      
      const text = el.textContent?.trim() || '';
      
      // Skip too short or too long texts
      if (text.length < 5 || text.length > 100) continue;
      
      // Skip if it's mostly numbers/dates
      if (/^\d+[\/\-\.\d\s:]+$/.test(text)) continue;
      if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(text)) continue;
      
      // Look for job-like patterns (all caps or title case with automotive keywords)
      const isAllCaps = text === text.toUpperCase() && /[A-Z]{3,}/.test(text);
      const hasJobKeywords = /tire|wheel|brake|oil|engine|transmission|alignment|service|repair|replace|install|inspect|filter|fluid|swap|change|mount|balance|rotate/i.test(text);
      
      // Check if parent/context suggests this is a job title
      const parentClasses = (el.parentElement?.className || '') + (el.className || '');
      const isInJobContext = /job|service|labor|work/i.test(parentClasses);
      
      if ((isAllCaps && hasJobKeywords) || (hasJobKeywords && isInJobContext)) {
        // Clean up the text (remove dates, statuses, etc.)
        let jobName = text.replace(/Approved.*$/i, '').replace(/Pending.*$/i, '').replace(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g, '').trim();
        
        // Skip if it looks like a labor description (usually longer and in sentence form)
        if (jobName.split(' ').length > 8) continue;
        
        // Skip if already seen or too generic
        if (seenJobs.has(jobName) || jobName.length < 5) continue;
        
        seenJobs.add(jobName);
        roInfo.jobs.push({
          name: jobName,
          description: jobName
        });
      }
    }
    
    // Strategy 2: Look for labor line items
    if (roInfo.jobs.length === 0) {
      const laborRows = document.querySelectorAll('tr, [class*="labor-row"], [class*="LaborRow"]');
      for (const row of laborRows) {
        const cells = row.querySelectorAll('td, [class*="cell"]');
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          if (text.length > 10 && text.length < 100 && /install|replace|repair|service|inspect/i.test(text)) {
            if (!seenJobs.has(text)) {
              seenJobs.add(text);
              roInfo.jobs.push({
                name: text,
                description: text
              });
            }
          }
        }
      }
    }
    
    // Strategy 3: Fallback - look for any automotive service terms
    if (roInfo.jobs.length === 0) {
      const allDivs = document.querySelectorAll('div, span, td');
      for (const el of allDivs) {
        const text = el.textContent?.trim() || '';
        if (text.length > 5 && text.length < 80) {
          const servicePatterns = /tire swap|oil change|brake (pad|rotor|service)|wheel alignment|transmission|filter|coolant flush|tune.?up|inspection|battery|belt|timing/i;
          if (servicePatterns.test(text) && !seenJobs.has(text)) {
            seenJobs.add(text);
            roInfo.jobs.push({
              name: text.substring(0, 80),
              description: text.substring(0, 80)
            });
          }
        }
      }
    }
    
    console.log('Extracted RO info:', roInfo);
  } catch (error) {
    console.error('Error extracting RO info:', error);
  }
  
  return roInfo;
}

/**
 * Shared symptom-based question guide used by the AI Concern Assistant prompts.
 *
 * Source of truth: attached_assets/Symptom-Based_Questions_1771359095699.docx
 * (uploaded by the shop owner). Kept as a code constant on purpose — no admin
 * UI, no runtime document loading, no DB storage.
 *
 * Both the dashboard route (`app/api/dashboard/concern-assistant/route.ts`)
 * and the extension route (`app/api/extension/concern-assistant/route.ts`)
 * import this same constant so the prompt stays in sync everywhere.
 */
export const SYMPTOM_QUESTION_GUIDE = `
GENERAL QUESTIONS (use when applicable, regardless of system):
- What is the make and model of your vehicle?
- How many miles are on your [make/model]?
- What symptoms are you experiencing?
- How long have you been experiencing these symptoms?
- Do these symptoms occur at a specific time or under specific conditions?
- Are any warning lights on? If yes, describe which ones.
- Tell me the story about your [issue/symptom]. What happened?

SYSTEM-SPECIFIC QUESTIONS:

CHECK ENGINE LIGHT:
- Tell me the story about your check engine light. What happened?
- How long has the warning light been on?
- Is the light flashing or steady?
- Are there additional warning lights on?

BATTERY / ALTERNATOR (VEHICLE WILL NOT START):
- Tell me the story about your battery or alternator issue. What happened?
- Have you had to jump-start the vehicle?
- Is the vehicle starting?
- Does it make any noise when you try to start it?
- Are the dashboard lights on when the key is turned to the "on" position?

BRAKES:
- Tell me the story about your brakes. What is happening?
- Are any warning lights on?
- Are you hearing any noises? If yes:
  - When does the noise occur?
  - Where does the noise seem to come from?
  - How long have you been hearing the noise?
  - Has the noise changed over time?
- Is the steering wheel shaking? If yes, does it happen while braking or all the time?
- Does the brake pedal feel different (e.g., soft, hard, or pulsating)?
- When was your last brake inspection?
- When were your brakes last replaced?

COOLING SYSTEM (leak, water pump, thermostat, radiator, etc.):
- Tell me the story about your [leak, water pump, thermostat, radiator, etc.]. What happened?
- Are any warning lights on?
- What is the temperature gauge on the dashboard reading?
- Are you seeing fluid on the ground under the engine?
- Do you see steam coming from the engine?

TRANSMISSION:
- Tell me the story about your transmission. What happened?
- Are any warning lights on?
- Is it automatic or manual transmission?
- Can the vehicle be driven to our shop, or will you need a tow service?
- Does the vehicle work in reverse?

STEERING AND SUSPENSION (noises, clunks, struts, tie rod ends, ball joints, etc.):
- Tell me the story about your [noise, clunk, struts, tie rod ends, ball joints, etc.]. What happened?
- Are any warning lights on?
- What symptoms are you experiencing?
- Under what conditions do these symptoms occur (e.g., when moving, turning, etc.)?
- Is the vehicle pulling to one side?
- Are you hearing any noises?

TIRES:
- Tell me the story about your tires. Why do they need to be replaced?
- What is the condition of your tires? Are they:
  - Worn out (tread at or below minimum)?
  - Too old (older than 8 years)?
  - Damaged (e.g., punctured and not repairable)?
- What are you looking for in a tire (e.g., performance, longevity)?
- Do you have a preferred tire brand?
- What is the size and brand of the tires currently on your vehicle?

ALIGNMENT:
- Tell me the story about your vehicle's alignment. What is happening?
- Have you recently had suspension, steering, or tire work done? If yes, by whom?
- Have you noticed vibrations, pulling, or anything unusual while driving?
- Have you hit a pothole or curb?
- When was your last alignment?

AIR CONDITIONING:
- Tell me the story about your air conditioning. What is happening?
- How long has the air conditioning not been working?
- Is the air conditioning blowing warm air?
- Does the air blow at all? Does it work at high or low speeds?
- When was the last time your air conditioning was charged or repaired?

TIMING BELT:
- Tell me the story about your timing belt. What happened?
- Is the vehicle running normally?
- Are you replacing the timing belt due to its age or mileage?
- Do you have service records for the vehicle?
- How many miles are on your vehicle?

EMISSIONS:
- Tell me the story about your emissions issue. What is happening?
- Are any warning lights on? (If yes, also use the Check Engine Light questions.)
- Are you noticing any symptoms?
- How long have you owned the vehicle?
- When is your vehicle registration due?
- Have you had a trusted shop perform emissions testing?

TUNE-UP:
- Tell me the story about your vehicle's tune-up needs. What symptoms are you experiencing?
- Are you seeking a tune-up to fix a specific problem or as routine maintenance?
- Is there anything specific you want to replace (e.g., spark plugs, filters)?
- How many miles are on your vehicle?
- Have you ever had a tune-up before?
- Are any warning lights on? (If yes, also use the Check Engine Light questions.)
- When was the last time your vehicle was serviced?
- Recommendation to offer: Would you like to schedule an oil service and inspection?

CUSTOMER-REPORTED SMELL:
- When did you first notice the odor?
- How long have you been experiencing the smell?
- Can you describe the smell? Is it:
  - Sweet?
  - Burning?
  - Musty?
  - Plastic-like?
- Where does the smell seem to be coming from?
- What steps can you take to replicate the smell?

ENGINE OR TRANSMISSION REPLACEMENT (price / "how much for an engine or transmission?"):
- Tell me more — what is going on with your engine (or transmission)?
- Tell me the story about what happened with your engine/transmission.
- Is the vehicle drivable, or would it have to be towed in?
- What sort of symptoms are you / were you having?
- How many miles do you have on your vehicle?
- Do you have a budget you are aiming for?
- Is this your everyday driver?
- Are you looking for a cheaper price or a second opinion?
- What are your long-term plans with the vehicle?
- Do you have a preference between used, new, or rebuilt?
- Soft recommendation: "Based on what you are telling me, if this were my vehicle I would bring it in for testing or for an inspection."
- Optional offer (only if shop owner allows): a free tow if the repair order is more than $500 or $1,000 — most engine or transmission repairs exceed $1,000.

COMMUNICATION STYLE (how to phrase things):
- Avoid: "What makes you think you need a…?"
  Instead say: "Tell me about the [issue/component]. What symptoms are you experiencing?"
- Avoid: "Have you had it inspected?"
  Instead say: "Have you had a trusted shop perform the necessary testing?"
- Use a calm, professional, conversational tone — like a service advisor talking to a customer at the counter, not an interrogator.
- Lead with story-based prompts ("Tell me the story about…") before drilling into specifics.
`;

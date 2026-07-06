NEVER make live PAID-API calls (Google Places, Gemini) while auditing — that spends the monthly cap.
Verify using the cached data under each job's data/ folder, synthetic fixtures, and the scratch DB.
Do not FAIL a task solely because you declined to make a paid call; if the task's core genuinely
cannot be verified without one, record that limitation rather than spending against the cap.

/**
 * Labeled question pairs for measuring the memory matcher. `same: true` pairs ask for the same decision in
 * different words; `same: false` pairs are the dangerous near-misses (same topic, different thing asked)
 * where reusing an answer would be wrong.
 */
export interface QuestionPair {
	a: string
	b: string
	same: boolean
}

export const QUESTION_PAIRS: QuestionPair[] = [
	// paraphrases
	{ a: "Which test framework should I use?", b: "What testing framework do we use for this project?", same: true },
	{ a: "Should I use TypeScript or JavaScript?", b: "TypeScript or JavaScript: which one should be used?", same: true },
	{ a: "What database do you want for sessions?", b: "Which database should the sessions use?", same: true },
	{ a: "Which package manager does the repo use?", b: "What package manager should be used in this repo?", same: true },
	{ a: "What port should the dev server run on?", b: "Which port should the dev server use?", same: true },
	{ a: "Do you want me to add unit tests?", b: "Should I add unit tests too?", same: true },
	{ a: "Should the API return 404 or 400 for a missing user?", b: "For a missing user should the API respond with 404 or 400?", same: true },
	{ a: "Which branch should I base this work on?", b: "What branch do I base the work on?", same: true },
	{ a: "What should the new endpoint be called?", b: "What name should the new endpoint have?", same: true },
	{ a: "Do you want the logs written as JSON?", b: "Should logs be written in JSON format?", same: true },
	{ a: "Which Node version should the CI use?", b: "What Node version should CI run on?", same: true },
	{ a: "Should I update the changelog for this change?", b: "Do I need to update the changelog with this change?", same: true },
	{ a: "Which linter configuration should I follow?", b: "What linter config should be followed?", same: true },
	{ a: "Where should the config file be located?", b: "Where should the config file live?", same: true },
	{ a: "Should the migration be reversible?", b: "Does the migration need to be reversible?", same: true },
	{ a: "Which cloud region should we deploy to?", b: "What region should the deployment go to?", same: true },
	// near-misses: same topic, different question
	{ a: "Which database should the sessions use?", b: "Which cache should the sessions use?", same: false },
	{ a: "Should I add unit tests?", b: "Should I add integration tests?", same: false },
	{ a: "What port should the dev server run on?", b: "What port should the database run on?", same: false },
	{ a: "Which test framework should I use?", b: "Which linting framework should I use?", same: false },
	{ a: "Should the API return 404 or 400 for a missing user?", b: "Should the API return 404 or 400 for a missing order?", same: false },
	{ a: "Which Node version should the CI use?", b: "Which Python version should the CI use?", same: false },
	{ a: "Should I update the changelog?", b: "Should I update the readme?", same: false },
	{ a: "Which branch should I base this work on?", b: "Which branch should I merge this work into?", same: false },
	{ a: "Should the migration be reversible?", b: "Should the migration run automatically?", same: false },
	{ a: "Where should the config file be located?", b: "Where should the log file be located?", same: false },
	{ a: "Do you want the logs written as JSON?", b: "Do you want the logs rotated daily?", same: false },
	{ a: "Which cloud region should we deploy to?", b: "Which cloud provider should we deploy to?", same: false },
	{ a: "What should the new endpoint be called?", b: "What should the new database table be called?", same: false },
	{ a: "Should I use TypeScript or JavaScript?", b: "Should I use tabs or spaces?", same: false },
	{ a: "Which package manager does the repo use?", b: "Which package version does the repo use?", same: false },
	{ a: "Should I add unit tests?", b: "Should I delete the old unit tests?", same: false },
]

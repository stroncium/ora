'use strict';
const readline = require('readline');
const chalk = require('chalk');
const cliCursor = require('cli-cursor');
const cliSpinners = require('cli-spinners');
const logSymbols = require('log-symbols');
const stripAnsi = require('strip-ansi');
const wcwidth = require('wcwidth');
const isInteractive = require('is-interactive');
const MuteStream = require('mute-stream');

const TEXT = Symbol('text');
const PREFIX_TEXT = Symbol('prefixText');

const ASCII_ETX_CODE = 0x03; // Ctrl+C emits this code

class StdinDiscarder {
	constructor() {
		this.requests = 0;

		this.mutedStream = new MuteStream();
		this.mutedStream.pipe(process.stdout);
		this.mutedStream.mute();

		const self = this;
		this.ourEmit = function (event, data, ...args) {
			const {stdin} = process;
			if (self.requests > 0 || stdin.emit === self.ourEmit) {
				if (event === 'keypress') { // Fixes readline behavior
					return;
				}

				if (event === 'data' && data.includes(ASCII_ETX_CODE)) {
					process.emit('SIGINT');
				}

				self.oldEmit.apply(this, [event, data, ...args]);
			} else {
				process.stdin.emit.apply(this, [event, data, ...args]);
			}
		};
	}

	start() {
		this.requests++;

		if (this.requests === 1) {
			this.realStart();
		}
	}

	stop() {
		if (this.requests <= 0) {
			throw new Error('`stop` called more times than `start`');
		}

		this.requests--;

		if (this.requests === 0) {
			this.realStop();
		}
	}

	realStart() {
		if (process.platform === 'win32') { // No known method to make it work under windows reliably
			return;
		}

		this.rl = readline.createInterface({
			input: process.stdin,
			output: this.mutedStream
		});

		this.rl.on('SIGINT', () => {
			if (process.listenerCount('SIGINT') === 0) {
				process.emit('SIGINT');
			} else {
				this.rl.close();
				process.kill(process.pid, 'SIGINT');
			}
		});
	}

	realStop() {
		if (process.platform === 'win32') { // No known method to make it work under windows reliably
			return;
		}

		this.rl.close();
		this.rl = undefined;
	}
}

const stdinDiscarder = new StdinDiscarder();

class Ora {
	constructor(options) {
		if (typeof options === 'string') {
			options = {
				text: options
			};
		}

		this.options = {
			text: '',
			color: 'cyan',
			stream: process.stderr,
			discardStdin: true,
			...options
		};

		this.spinner = this.options.spinner;

		this.color = this.options.color;
		this.hideCursor = this.options.hideCursor !== false;
		this.interval = this.options.interval || this.spinner.interval || 100;
		this.stream = this.options.stream;
		this.id = undefined;
		this.isEnabled = typeof this.options.isEnabled === 'boolean' ? this.options.isEnabled : isInteractive({stream: this.stream});

		// Set *after* `this.stream`
		this.text = this.options.text;
		this.prefixText = this.options.prefixText;
		this.linesToClear = 0;
		this.indent = this.options.indent;
		this.discardStdin = this.options.discardStdin;
		this.isDiscardingStdin = false;
	}

	get indent() {
		return this._indent;
	}

	set indent(indent = 0) {
		if (!(indent >= 0 && Number.isInteger(indent))) {
			throw new Error('The `indent` option must be an integer from 0 and up');
		}

		this._indent = indent;
	}

	_updateInterval(interval) {
		if (interval !== undefined) {
			this.interval = interval;
		}
	}

	get spinner() {
		return this._spinner;
	}

	set spinner(spinner) {
		this.frameIndex = 0;

		if (typeof spinner === 'object') {
			if (spinner.frames === undefined) {
				throw new Error('The given spinner must have a `frames` property');
			}

			this._spinner = spinner;
		} else if (process.platform === 'win32') {
			this._spinner = cliSpinners.line;
		} else if (spinner === undefined) {
			// Set default spinner
			this._spinner = cliSpinners.dots;
		} else if (cliSpinners[spinner]) {
			this._spinner = cliSpinners[spinner];
		} else {
			throw new Error(`There is no built-in spinner named '${spinner}'. See https://github.com/sindresorhus/cli-spinners/blob/master/spinners.json for a full list.`);
		}

		this._updateInterval(this._spinner.interval);
	}

	get text() {
		return this[TEXT];
	}

	get prefixText() {
		return this[PREFIX_TEXT];
	}

	get isSpinning() {
		return this.id !== undefined;
	}

	updateLineCount() {
		const columns = this.stream.columns || 80;
		const fullPrefixText = (typeof this[PREFIX_TEXT] === 'string') ? this[PREFIX_TEXT] + '-' : '';
		this.lineCount = stripAnsi(fullPrefixText + '--' + this[TEXT]).split('\n').reduce((count, line) => {
			return count + Math.max(1, Math.ceil(wcwidth(line) / columns));
		}, 0);
	}

	set text(value) {
		this[TEXT] = value;
		this.updateLineCount();
	}

	set prefixText(value) {
		this[PREFIX_TEXT] = value;
		this.updateLineCount();
	}

	frame() {
		const {frames} = this.spinner;
		let frame = frames[this.frameIndex];

		if (this.color) {
			frame = chalk[this.color](frame);
		}

		this.frameIndex = ++this.frameIndex % frames.length;
		const fullPrefixText = (typeof this.prefixText === 'string' && this.prefixText !== '') ? this.prefixText + ' ' : '';
		const fullText = typeof this.text === 'string' ? ' ' + this.text : '';

		return fullPrefixText + frame + fullText;
	}

	clear() {
		if (!this.isEnabled || !this.stream.isTTY) {
			return this;
		}

		for (let i = 0; i < this.linesToClear; i++) {
			if (i > 0) {
				this.stream.moveCursor(0, -1);
			}

			this.stream.clearLine();
			this.stream.cursorTo(this.indent);
		}

		this.linesToClear = 0;

		return this;
	}

	render() {
		this.clear();
		this.stream.write(this.frame());
		this.linesToClear = this.lineCount;

		return this;
	}

	start(text) {
		if (text) {
			this.text = text;
		}

		if (!this.isEnabled) {
			this.stream.write(`- ${this.text}\n`);
			return this;
		}

		if (this.isSpinning) {
			return this;
		}

		if (this.hideCursor) {
			cliCursor.hide(this.stream);
		}

		if (this.discardStdin && process.stdin.isTTY) {
			this.isDiscardingStdin = true;
			stdinDiscarder.start();
		}

		this.render();
		this.id = setInterval(this.render.bind(this), this.interval);

		return this;
	}

	stop() {
		if (!this.isEnabled) {
			return this;
		}

		clearInterval(this.id);
		this.id = undefined;
		this.frameIndex = 0;
		this.clear();
		if (this.hideCursor) {
			cliCursor.show(this.stream);
		}

		if (this.discardStdin && process.stdin.isTTY && this.isDiscardingStdin) {
			stdinDiscarder.stop();
			this.isDiscardingStdin = false;
		}

		return this;
	}

	succeed(text) {
		return this.stopAndPersist({symbol: logSymbols.success, text});
	}

	fail(text) {
		return this.stopAndPersist({symbol: logSymbols.error, text});
	}

	warn(text) {
		return this.stopAndPersist({symbol: logSymbols.warning, text});
	}

	info(text) {
		return this.stopAndPersist({symbol: logSymbols.info, text});
	}

	stopAndPersist(options = {}) {
		const prefixText = options.prefixText || this.prefixText;
		const fullPrefixText = (typeof prefixText === 'string' && prefixText !== '') ? prefixText + ' ' : '';
		const text = options.text || this.text;
		const fullText = (typeof text === 'string') ? ' ' + text : '';

		this.stop();
		this.stream.write(`${fullPrefixText}${options.symbol || ' '}${fullText}\n`);

		return this;
	}
}

const oraFactory = function (options) {
	return new Ora(options);
};

module.exports = oraFactory;

module.exports.promise = (action, options) => {
	// eslint-disable-next-line promise/prefer-await-to-then
	if (typeof action.then !== 'function') {
		throw new TypeError('Parameter `action` must be a Promise');
	}

	const spinner = new Ora(options);
	spinner.start();

	(async () => {
		try {
			await action;
			spinner.succeed();
		} catch (_) {
			spinner.fail();
		}
	})();

	return spinner;
};

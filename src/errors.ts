export class HnApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public details: string,
    public url?: string,
  ) {
    super(`${endpoint} failed (${statusCode || 'network'}): ${details}`);
    this.name = 'HnApiError';
  }

  toJSON() {
    let hint: string | undefined;
    if (this.statusCode === 429) hint = 'Rate limited by the upstream API. Wait a minute, then retry with a smaller --limit or fewer keywords.';
    else if (this.statusCode >= 500) hint = 'Upstream API error. Run `hn status` to check reachability, then retry.';
    else if (this.statusCode === 0) hint = 'Network error. Check connectivity, or raise the timeout with `hn config set --timeout-ms 40000`.';
    return {
      error: this.name,
      status_code: this.statusCode,
      endpoint: this.endpoint,
      details: this.details,
      url: this.url,
      hint,
    };
  }
}

export class NotFoundError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = 'NotFoundError';
  }

  toJSON() {
    return { error: this.name, message: this.message, hint: this.hint };
  }
}

export class UsageError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = 'UsageError';
  }

  toJSON() {
    return { error: this.name, message: this.message, hint: this.hint };
  }
}

export class ConfigError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = 'ConfigError';
  }

  toJSON() {
    return { error: this.name, message: this.message, hint: this.hint };
  }
}

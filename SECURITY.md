# Security Policy

## Supported versions

WEFT is in active development and does not currently provide stable releases or long-term support.
We accept vulnerability reports concerning the current development branch (`main`) and the latest
publicly released development version, when one exists. Accepting reports for a release does not
guarantee security fixes, backports, or ongoing security support.

## Reporting a vulnerability

Please use GitHub Private Vulnerability Reporting as the preferred reporting channel. Sign in to
GitHub, open [WEFT's Security Advisories](https://github.com/cludewn/WEFT/security/advisories), and
choose **Report a vulnerability**. Complete the private reporting form and select **Submit report**.

If **Report a vulnerability** is unavailable, open an
[issue](https://github.com/cludewn/WEFT/issues/new) asking only how to contact the maintainer privately
about a security concern. Do not include any vulnerability details or proof-of-concept material in
that public issue. Wait for a private reporting channel before sharing those details.

Do not disclose vulnerability details or proof-of-concept material in public issues, pull requests,
or discussions before coordinating disclosure with the maintainer.

## Report contents

Include the following information in your private report, where available:

- A vulnerability summary.
- The affected component and version, Git commit SHA, or image tag.
- Reproduction steps or a proof of concept.
- The potential impact.
- Relevant environment details, such as Node.js and PostgreSQL versions and deployment method.

Use placeholders instead of real credentials. Remove Discord bot tokens, passwords, API keys,
credential-bearing connection strings, webhook URLs, and other sensitive information from logs,
screenshots, and attachments before sharing them. Never post credentials or private data publicly.

## Disclosure and response

The maintainer will review and investigate reports privately and coordinate with the reporter on
fixes and public disclosure as appropriate. Please keep vulnerability details private while that
coordination is in progress.

As a project in development, WEFT does not guarantee response or resolution deadlines, a security
support period, or rewards for reports.

## Ordinary bugs

For bugs unrelated to security, use the
[Bug report form](https://github.com/cludewn/WEFT/issues/new?template=bug_report.yml).

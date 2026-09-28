# Subnet Calculator

A browser-based subnet calculator for analyzing IPv4 and IPv6 addresses. It calculates network details, address ranges, subnet masks, host information, and more.

## Features

- Supports IPv4 and IPv6 addresses
- Calculates network and broadcast addresses
- Displays usable host ranges and address counts
- Supports CIDR prefixes and subnet masks
- Shows network and host bit breakdowns
- Identifies address types and IPv4 classes
- Includes light and dark themes
- Provides copy-to-clipboard tools
- Runs entirely in the browser

## Getting Started

1. Open the project in Visual Studio Code.
2. Launch `index.html` in a web browser.
3. Enter an IP address with a prefix, such as `192.168.1.10/24`.
4. Click **Calculate** to view the subnet details.

## Example Inputs

- `192.168.1.10/24`
- `192.168.1.10 255.255.255.0`
- `10.0.0.0/8`
- `2001:db8::1/64`
- `fe80::1/10`

## Purpose

This project was created to practice JavaScript, IP address parsing, subnet calculations, BigInt operations, DOM manipulation, accessibility, and responsive web design.

## Privacy

All calculations are performed locally in the browser. No data is sent to a server.

## License

This project is intended for learning and practice.
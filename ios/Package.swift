// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Chadoodle",
    platforms: [
        .iOS(.v17),
    ],
    products: [
        .library(
            name: "Chadoodle",
            targets: ["Chadoodle"]
        ),
    ],
    targets: [
        .target(
            name: "Chadoodle",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)

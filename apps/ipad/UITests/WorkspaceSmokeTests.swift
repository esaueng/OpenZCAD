import XCTest

final class WorkspaceSmokeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testWorkspaceFillsTheTabletInBothOrientations() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
        for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            let fillsWindow = NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                let web = app.webViews.firstMatch.frame
                let canvas = app.otherElements.matching(NSPredicate(format: "label == %@", "3D viewport, region")).firstMatch.frame
                return (window.width > window.height) == orientation.isLandscape
                    && abs(web.minY - window.minY) < 1 && abs(web.maxY - window.maxY) < 1
                    && abs(web.minX - window.minX) < 1 && abs(web.maxX - window.maxX) < 1
                    && abs(canvas.minY - window.minY) < 1 && abs(canvas.maxY - window.maxY) < 1
            }
            expectation(for: fillsWindow, evaluatedWith: app)
            waitForExpectations(timeout: 15)
            let screen = XCUIScreen.main
            expectation(for: NSPredicate { _, _ in
                let size = screen.screenshot().image.size
                return (size.width > size.height) == orientation.isLandscape
            }, evaluatedWith: app)
            waitForExpectations(timeout: 15)
            let image = XCTAttachment(screenshot: screen.screenshot())
            image.name = orientation == .portrait ? "Full-screen portrait" : "Full-screen landscape"
            image.lifetime = .keepAlways
            add(image)
        }
        XCUIDevice.shared.orientation = .portrait
    }

    func testTouchSketchAndExtrude() {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let projectName = "iPad Sketch Smoke \(UUID().uuidString.prefix(8))"
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        let home = app.buttons["OpenZCAD"].firstMatch
        if home.waitForExistence(timeout: 10) { home.tap() }
        let name = app.textFields["Project name"]
        XCTAssertTrue(name.waitForExistence(timeout: 30))
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (name.value as? String ?? "").count) + projectName)
        app.buttons["New project"].tap()
        let sketch = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Sketch (S)")).firstMatch
        XCTAssertTrue(sketch.waitForExistence(timeout: 30))
        if app.buttons["Skip the tour"].exists { app.buttons["Skip the tour"].tap() }
        sketch.tap()
        app.buttons["Top (XY)"].tap()
        let rectangle = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Rectangle")).firstMatch
        XCTAssertTrue(rectangle.waitForExistence(timeout: 10), app.debugDescription)
        rectangle.tap()
        let canvas = app.otherElements.matching(NSPredicate(format: "label == %@", "3D viewport, region")).firstMatch
        let start = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.34, dy: 0.42))
        let end = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.56, dy: 0.56))
        start.press(forDuration: 0.05, thenDragTo: end)
        app.buttons["Finish Sketch"].tap()
        if app.buttons["Skip the tour"].exists { app.buttons["Skip the tour"].tap() }
        let extrude = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Extrude (E)")).firstMatch
        XCTAssertTrue(extrude.isEnabled)
        extrude.tap()
        let distance = app.buttons["+ 0 mm"].firstMatch
        XCTAssertTrue(distance.waitForExistence(timeout: 10), app.debugDescription)
        distance.tap()
        let value = app.textFields["Distance"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10), app.debugDescription)
        value.tap()
        value.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (value.value as? String ?? "").count) + "12")
        app.buttons["Apply distance"].tap()
        let done = app.buttons["Done"].firstMatch
        let ready = NSPredicate(format: "enabled == true")
        expectation(for: ready, evaluatedWith: done)
        waitForExpectations(timeout: 30)
        done.tap()
        let body = app.otherElements.matching(NSPredicate(format: "label CONTAINS %@", "2 features · 1 body. Sync Local only.")).firstMatch
        XCTAssertTrue(body.waitForExistence(timeout: 30), app.debugDescription)
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(body.waitForExistence(timeout: 20))
        app.terminate()
        app.launch()
        XCTAssertTrue(body.waitForExistence(timeout: 30), "Sketch and extrude history must reopen from durable storage.")
        print(app.debugDescription)
    }

    func testBundledWorkspaceLoads() {
        let projectName = "iPad Prototype Smoke \(UUID().uuidString.prefix(8))"
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        let home = app.buttons["OpenZCAD"].firstMatch
        if home.waitForExistence(timeout: 10) { home.tap() }
        let newProject = app.buttons["New project"]
        XCTAssertTrue(newProject.waitForExistence(timeout: 30), app.debugDescription)
        let name = app.textFields["Project name"]
        name.tap()
        let oldValue = name.value as? String ?? ""
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: oldValue.count) + projectName)
        newProject.tap()
        let box = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Box (B)")).firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 30), app.debugDescription)
        box.tap()
        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
        let solid = app.otherElements.matching(NSPredicate(format: "label CONTAINS %@", "1 body. Sync Local only.")).firstMatch
        XCTAssertTrue(solid.waitForExistence(timeout: 30), app.debugDescription)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Rename project \(projectName)"].waitForExistence(timeout: 30))
        XCTAssertTrue(solid.waitForExistence(timeout: 30), "The saved model must survive process termination.")
        app.buttons["File"].firstMatch.tap()
        let export = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Export STEP")).firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 10), app.debugDescription)
        export.tap()
        let picker = app.navigationBars.firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.buttons["Save"].firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Save"].firstMatch.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Save"].firstMatch)
        waitForExpectations(timeout: 15)
        XCTAssertTrue(app.buttons["Rename project \(projectName)"].isHittable, app.debugDescription)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iPad native CAD workspace"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        print(app.debugDescription)
    }
}

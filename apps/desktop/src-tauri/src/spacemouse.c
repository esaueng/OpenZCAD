#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDManager.h>
#include <stdint.h>

typedef void (*ReportSink)(void *, const uint8_t *, size_t);

typedef struct {
    IOHIDManagerRef manager;
    IOHIDDeviceRef device;
    ReportSink sink;
    void *context;
} SpaceMouse;

static void input_report(void *context, IOReturn result, void *sender,
                         IOHIDReportType type, uint32_t id, uint8_t *report,
                         CFIndex length) {
    SpaceMouse *reader = context;
    if (result == kIOReturnSuccess && type == kIOHIDReportTypeInput &&
        length == 7 && id == report[0] && id >= 1 && id <= 3 &&
        (!reader->device || reader->device == sender)) {
        if (!reader->device) {
            reader->device = (IOHIDDeviceRef)CFRetain(sender);
        }
        reader->sink(reader->context, report, (size_t)length);
    }
}

static void removed(void *context, IOReturn result, void *sender,
                    IOHIDDeviceRef device) {
    (void)result;
    (void)sender;
    SpaceMouse *reader = context;
    if (reader->device == device) {
        CFRelease(reader->device);
        reader->device = NULL;
        reader->sink(reader->context, NULL, 0);
    }
}

SpaceMouse *openzcad_spacemouse_start(ReportSink sink, void *context) {
    SpaceMouse *reader = calloc(1, sizeof(*reader));
    if (!reader) return NULL;
    reader->sink = sink;
    reader->context = context;
    reader->manager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
    if (!reader->manager) {
        free(reader);
        return NULL;
    }

    int values[] = {0x046d, 0xc62b, 0x01, 0x08};
    const void *keys[] = {CFSTR(kIOHIDVendorIDKey), CFSTR(kIOHIDProductIDKey),
                          CFSTR(kIOHIDPrimaryUsagePageKey), CFSTR(kIOHIDPrimaryUsageKey)};
    const void *numbers[4];
    for (size_t i = 0; i < 4; i++) {
        numbers[i] = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &values[i]);
    }
    CFDictionaryRef matching = CFDictionaryCreate(
        kCFAllocatorDefault, keys, numbers, 4, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    IOHIDManagerSetDeviceMatching(reader->manager, matching);
    CFRelease(matching);
    for (size_t i = 0; i < 4; i++) CFRelease(numbers[i]);

    IOHIDManagerRegisterInputReportCallback(reader->manager, input_report, reader);
    IOHIDManagerRegisterDeviceRemovalCallback(reader->manager, removed, reader);
    if (IOHIDManagerOpen(reader->manager, kIOHIDOptionsTypeNone) != kIOReturnSuccess) {
        CFRelease(reader->manager);
        free(reader);
        return NULL;
    }
    IOHIDManagerScheduleWithRunLoop(reader->manager, CFRunLoopGetMain(), kCFRunLoopDefaultMode);
    return reader;
}

void openzcad_spacemouse_stop(SpaceMouse *reader) {
    IOHIDManagerUnscheduleFromRunLoop(reader->manager, CFRunLoopGetMain(), kCFRunLoopDefaultMode);
    IOHIDManagerClose(reader->manager, kIOHIDOptionsTypeNone);
    CFRelease(reader->manager);
    if (reader->device) CFRelease(reader->device);
    free(reader);
}

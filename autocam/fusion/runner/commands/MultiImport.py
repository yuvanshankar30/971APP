# Created by Portland CNC
# URL: https://pdxcnc.com

import adsk.core, adsk.fusion, traceback
import os
from .GroupingValidation import require_positive_quantity


def importFiles(filenames, quantities):
    if len(filenames) != len(quantities) or not filenames:
        raise ValueError('Every STEP file must have a requested quantity')
    for quantity in quantities:
        require_positive_quantity(quantity)
    app = adsk.core.Application.get()
    app.log(str(filenames))
    ui = app.userInterface
    design = app.activeProduct
    rootComp = design.rootComponent
    for filename, quantity in zip(filenames, quantities):
        componentName = os.path.splitext(os.path.basename(filename))[0]
        importOptions = app.importManager.createSTEPImportOptions(filename)
        quantity = int(quantity)
        for _ in range(quantity):
            before_count = rootComp.occurrences.count
            if not app.importManager.importToTarget(importOptions, rootComp):
                raise RuntimeError(f'Could not import {filename}')
            if rootComp.occurrences.count != before_count + 1:
                raise ValueError('Each plate STEP must import as one single-body component')
            lastOcc = rootComp.occurrences[-1]
            if lastOcc.bRepBodies.count != 1 or lastOcc.childOccurrences.count:
                raise ValueError('Plate grouping supports single-body parts; split assemblies or multi-body STEP files first')
            lastOcc.component.name = componentName